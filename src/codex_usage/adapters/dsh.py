"""Read DSH's canonical Session generation, including compact V4 streams."""

import json
import os
from pathlib import Path
import re
from typing import Any

import zstandard

from ..domain import ParseBatch, SourceFile, TimingSample, UsageEvent, timestamp_us
from .common import count, lines
from .conversation import ConversationLedger

_LOG = re.compile(r"^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$")
_MAX_DECODED = 256 * 1024 * 1024


def decode_zstd(path):
    """Decode concatenated frames; keep complete frames before a torn append."""
    output = bytearray()
    frame = bytearray()
    decoder = zstandard.ZstdDecompressor().decompressobj()
    frame_open = False
    with Path(path).open("rb") as source:
        while raw := source.read(65536):
            while raw:
                frame_open = True
                try:
                    frame.extend(decoder.decompress(raw))
                except zstandard.ZstdError as error:
                    raise ValueError("Corrupt compressed DSH log") from error
                if len(output) + len(frame) > _MAX_DECODED:
                    raise ValueError("Decoded DSH log exceeds size limit")
                if not decoder.eof:
                    break
                output.extend(frame)
                frame.clear()
                raw = decoder.unused_data
                decoder = zstandard.ZstdDecompressor().decompressobj()
                frame_open = False
    return bytes(output), frame_open


class DshAdapter:
    harness = "dsh"
    supports_incremental = False

    def __init__(self, root: str | Path | None = None):
        self.root = Path(root or os.environ.get("DSH_HOME") or Path.home() / ".dsh")

    def discover(self):
        directories: dict[Path, list[tuple[int, Path]]] = {}
        for path in (self.root / "sessions").rglob("session*.jsonl*"):
            match = _LOG.fullmatch(path.name)
            if match and path.is_file():
                generation = int(match.group(1) or 0)
                directories.setdefault(path.parent, []).append((generation, path))
        for directory, candidates in sorted(directories.items()):
            # Migrated historical generations remain immutable beside the current
            # file. Select the newest even when unsupported; never show stale totals.
            _, path = max(candidates, key=lambda pair: (pair[0], pair[1].suffix == ".zstd"))
            yield SourceFile(str(path), self.harness, "generation", str(directory))

    def parse_file(self, path, offset=0, state=None):
        batch = ParseBatch()
        if str(path).endswith(".zstd"):
            raw, torn = decode_zstd(path)
            records = []
            for line in raw.splitlines(keepends=True):
                if not line.endswith(b"\n"):
                    batch.warnings.append("Incomplete final JSONL line")
                    break
                if not line.strip():
                    continue
                batch.records_read += 1
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        raise ValueError("record must be an object")
                    records.append(record)
                except (ValueError, UnicodeError):
                    batch.warnings.append("Invalid JSON record")
            batch.next_offset = Path(path).stat().st_size
            if torn:
                batch.warnings.append("Incomplete final zstd frame; complete frames retained")
        else:
            records = [record for _, record in lines(path, 0, batch)]
        info = next((record for record in records if record.get("type") == "session"), {})
        version = info.get("version")
        match = _LOG.fullmatch(Path(path).name)
        if version not in {0, 1, 2, 3, 4} or not match or version != int(match.group(1) or 0):
            batch.warnings.append("Unsupported DSH generation or header/filename mismatch")
            return batch
        sid = str(info.get("id") or Path(path).parent.name)
        inherited = -1
        if version <= 1:
            if info.get("parentSession"):
                inherited = count(info.get("seedLength"), 0) - 1
        else:
            cuts = [int(r["seq"]) for r in records if r.get("type") == "session/end-seed"
                    and r.get("data", {}).get("inherited") is True and count(r.get("seq")) is not None]
            if info.get("isSeeded") is True and not cuts:
                batch.warnings.append("Seeded DSH session has no inherited-prefix boundary")
                return batch
            if cuts and info.get("isSeeded") is not True:
                batch.warnings.append("Unseeded DSH session has an inherited-prefix boundary")
                return batch
            inherited = max(cuts, default=-1)
        provider = None
        model = "unknown"
        current_turn = 0
        slots: dict[tuple, int] = {}
        observations = {}
        settled = set()
        turns: dict[int, dict[str, Any]] = {}
        ledger = ConversationLedger(self.harness, path)
        tool_steps: dict[tuple, set[str]] = {}
        auxiliary_without_usage = set()
        for record in records:
            kind = record.get("type")
            data = record.get("data") or {}
            if kind == "request/header":
                config = (data.get("header") or {}).get("config") or {}
                model = config.get("model") or model
                provider = config.get("provider") or provider
            elif kind == "request/context":
                model = data.get("model") or model
                provider = data.get("provider") or provider
            if record.get("seq", -1) <= inherited or kind == "session":
                continue
            if kind in {"session/title-llm-request", "web/deepseek-search-llm-request"}:
                auxiliary_without_usage.add(kind)
            when = timestamp_us(record.get("time"))
            if kind == "turn/start":
                current_turn = data.get("turn", current_turn)
                turns[current_turn] = {"start": when, "models": set(), "output": 0,
                                       "complete": True}
                if when is not None:
                    ledger.start(
                        sid, str(current_turn), when, parent=info.get("parentSession"),
                        project=info.get("cwd"), agent_type=info.get("origin") or
                        ("subagent" if info.get("delegationDepth", 0) > 0 else "main"),
                        quality="exact")
            turn, step = data.get("turn", current_turn), data.get("step", 0)
            coordinate = (turn, step)
            turn_id = str(turn) if count(turn) is not None else None
            if kind == "turn/end":
                reason = data.get("reason")
                reason_kind = reason.get("kind") if isinstance(reason, dict) else reason
                status = ("completed" if reason_kind == "completed" else
                          "aborted" if reason_kind in {"aborted", "interrupted", "forked"} else
                          "error" if reason_kind == "error" else "unknown")
                ledger.finish(sid, turn_id, when, status)
            if kind == "tool/call":
                call_id = data.get("callId")
                ledger.call(sid, call_id, data.get("name"), when, turn_id)
                if call_id:
                    tool_steps.setdefault(coordinate, set()).add(call_id)
            elif kind == "tool/result":
                message = data.get("message") or {}
                call_id = message.get("toolCallId") or data.get("callId")
                if not call_id:
                    # Some historical records only carry step coordinates. A
                    # unique pending invocation is the sole unambiguous match.
                    pending = [identity for identity in tool_steps.get(coordinate, ()) if
                               ledger.tools.get(f"{sid}:tool:{identity}", {}).get("end_us") is None]
                    call_id = pending[0] if len(pending) == 1 else None
                ledger.result(sid, call_id, when,
                              bool(message.get("isError") or data.get("error")), turn_id)
            if kind == "llm/retry-started":
                slots[coordinate] = slots.get(coordinate, 0) + 1
                settled.discard(coordinate)
                continue
            if kind not in {"assistant/message", "assistant/attempt", "assistant/chunk"}:
                continue
            if kind == "assistant/chunk" and version > 1:
                continue
            usage = data.get("usage")
            if kind == "assistant/chunk":
                chunk = data.get("chunk") or {}
                if chunk.get("type") != "usage":
                    continue
                usage = chunk.get("usage")
            if not isinstance(usage, dict):
                for stream_record in reversed(data.get("stream") or []):
                    chunk = stream_record.get("chunk") or {}
                    if chunk.get("type") == "usage":
                        usage = chunk.get("usage")
                        break
            if not isinstance(usage, dict):
                batch.warnings.append("Model attempt has no recorded usage; totals are incomplete")
                if turn in turns:
                    turns[turn]["complete"] = False
                continue
            net, out = count(usage.get("inputTokens")), count(usage.get("outputTokens"))
            if net is None or out is None or when is None:
                batch.warnings.append("Model usage has incomplete counters or timestamp")
                continue
            if version >= 2 and coordinate in settled:
                slots[coordinate] = slots.get(coordinate, 0) + 1
            if kind != "assistant/chunk":
                settled.add(coordinate)
            key = f"{sid}:{turn}:{step}:{slots.get(coordinate, 0)}"
            source = (data.get("message") or {}).get("source") or {}
            observations[key] = UsageEvent(
                key=key, timestamp_us=when, harness=self.harness, session_id=sid,
                source_file=path, parent_session_id=info.get("parentSession"), turn_id=turn_id,
                provider=source.get("provider") or provider, model=source.get("model") or model,
                project=info.get("cwd"), agent_type=info.get("origin") or
                ("subagent" if info.get("delegationDepth", 0) > 0 else "main"),
                input_net=net, output=out, cache_read=count(usage.get("cacheReadTokens"), 0),
                cache_write=count(usage.get("cacheWriteTokens")),
                reasoning=count(usage.get("reasoningTokens")), source_total=count(usage.get("totalTokens")))
            # Modern settlements represent separate attempts. Legacy chunks are
            # snapshots of their final message and must contribute once.
        batch.events = list(observations.values())
        # Turn route sets are updated by finalized accounting, avoiding chunk repeats.
        for turn, timing in turns.items():
            matching = [event for event in batch.events if event.key.startswith(f"{sid}:{turn}:")]
            timing["models"] = {(event.provider, event.model) for event in matching}
            timing["output"] = sum(event.output for event in matching)
        # Emit complete single-model turn spans from recorded turn boundaries.
        for record in records:
            if record.get("type") != "turn/end" or record.get("seq", -1) <= inherited:
                continue
            data = record.get("data") or {}
            reason = data.get("reason")
            if not isinstance(reason, dict) or reason.get("kind") != "completed":
                continue
            if count(data.get("turn")) is None:
                continue
            turn = int(data["turn"])
            turn_timing = turns.get(turn)
            end = timestamp_us(record.get("time"))
            if (turn_timing and turn_timing["complete"] and turn_timing["start"] is not None
                    and end is not None and end > turn_timing["start"]
                    and len(turn_timing["models"]) == 1):
                route = next(iter(turn_timing["models"]))
                batch.timing_samples.append(TimingSample(
                    key=f"{sid}:turn:{turn}", harness=self.harness, session_id=sid,
                    model=route[1], provider=route[0], start_us=turn_timing["start"], end_us=end,
                    output=turn_timing["output"], source_file=path, turn_id=str(turn)))
        ledger.flush(batch, structurally_complete=not any(
            "Invalid JSON" in item or "Incomplete final" in item for item in batch.warnings))
        batch.state = {"format_version": version, "session_id": sid}
        for kind in sorted(auxiliary_without_usage):
            batch.warnings.append(f"Auxiliary {kind} metadata has no persisted usage accounting")
        return batch
