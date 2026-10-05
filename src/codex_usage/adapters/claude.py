"""Claude Code transcripts: content blocks repeat usage for the same response."""

import os
from pathlib import Path

from ..domain import ParseBatch, SourceFile, UsageEvent, timestamp_us
from .common import count, lines
from .conversation import ConversationLedger


class ClaudeAdapter:
    harness = "claude"

    def __init__(self, root: str | Path | None = None):
        self.root = Path(root or os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")

    def discover(self):
        for path in sorted((self.root / "projects").rglob("*.jsonl")):
            yield SourceFile(str(path), self.harness)

    def parse_file(self, path, offset=0, state=None):
        current = dict(state or {})
        first_times = dict(current.get("first_times", {}))
        batch = ParseBatch(state=current)
        ledger = ConversationLedger(self.harness, path, current.get("conversation"))
        events = {}
        for position, record in lines(path, offset, batch):
            message = record.get("message") or {}
            when = timestamp_us(record.get("timestamp"))
            sid = str(record.get("sessionId") or Path(path).stem)
            agent = record.get("agentId")
            session = f"{sid}/{agent}" if agent else sid
            parent = sid if agent else None
            agent_type = "subagent" if agent or record.get("isSidechain") else "main"
            content = message.get("content")
            blocks = content if isinstance(content, list) else []
            results = [block for block in blocks if isinstance(block, dict) and
                       block.get("type") == "tool_result"]
            user = (record.get("type") == "user" and message.get("role") == "user" and
                    not results and not record.get("sourceToolAssistantUUID") and
                    not any(record.get(flag) for flag in (
                        "isMeta", "isCompactSummary", "isVisibleInTranscriptOnly",
                        "queueTranscriptOnly", "turnCompanion")) and
                    bool(content))
            node_id = record.get("uuid") or (f"byte:{position}" if user else None)
            turn_id = ledger.observe_node(
                session, node_id, record.get("parentUuid"), when, user=user,
                parent=parent, project=record.get("cwd"), agent_type=agent_type)
            for result in results:
                ledger.result(session, result.get("tool_use_id"), when,
                              bool(result.get("is_error")), turn_id)
            if record.get("type") == "system" and record.get("subtype") == "turn_duration":
                ledger.finish(session, turn_id, when, "completed")
            if record.get("type") != "assistant":
                continue
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    ledger.call(session, block.get("id"), block.get("name"), when, turn_id)
            reason = message.get("stop_reason")
            if record.get("isApiErrorMessage"):
                ledger.finish(session, turn_id, when, "error")
            elif reason in {"end_turn", "stop_sequence"}:
                ledger.finish(session, turn_id, when, "completed")
            usage = message.get("usage")
            if not isinstance(usage, dict):
                batch.warnings.append("Assistant response has no usage")
                continue
            if when is None:
                batch.warnings.append("Assistant usage has no valid timestamp")
                continue
            identity = message.get("id")
            key = (f"{identity}:{record.get('requestId') or ''}" if identity else
                   f"{session}:{position}")
            when = first_times.setdefault(key, when)
            route = message.get("model") or "unknown"
            input_tokens = count(usage.get("input_tokens"))
            output_tokens = count(usage.get("output_tokens"))
            if input_tokens is None or output_tokens is None:
                batch.warnings.append("Assistant usage has incomplete token counters")
                continue
            if route == "<synthetic>" and not any((input_tokens, output_tokens,
                    count(usage.get("cache_read_input_tokens"), 0),
                    count(usage.get("cache_creation_input_tokens"), 0))):
                # Claude writes local synthetic messages with a zero usage shell;
                # these did not call a model and cannot count as unpriced requests.
                continue
            cache_creation = usage.get("cache_creation") or {}
            write5 = count(cache_creation.get("ephemeral_5m_input_tokens"))
            write1 = count(cache_creation.get("ephemeral_1h_input_tokens"))
            write = count(usage.get("cache_creation_input_tokens"))
            if write is None and write5 is not None and write1 is not None:
                write = write5 + write1
            extra = {}
            if write5 is not None:
                extra["cache_write_5m"] = write5
            if write1 is not None:
                extra["cache_write_1h"] = write1
            reasoning = count((usage.get("output_tokens_details") or {}).get("thinking_tokens"))
            events[key] = UsageEvent(
                key=key, timestamp_us=when, harness=self.harness, session_id=session,
                source_file=path, parent_session_id=parent, turn_id=turn_id,
                provider=None, model=route, project=record.get("cwd"),
                agent_type=agent_type,
                agent_label=agent, service_tier=usage.get("speed") or usage.get("service_tier"),
                input_net=input_tokens, output=output_tokens,
                cache_read=count(usage.get("cache_read_input_tokens"), 0),
                cache_write=write, reasoning=reasoning, extra_tokens=extra,
                quality="exact" if identity else "identity_unknown")
            # Advisor iterations carry separate model accounting. Ordinary iterations
            # already contribute to the response's top-level counters.
            advisor_index = 0
            for iteration in usage.get("iterations") or []:
                if not isinstance(iteration, dict) or iteration.get("type") != "advisor_message":
                    continue
                advisor_key = f"{key}:advisor:{advisor_index}"
                advisor_index += 1
                net = count(iteration.get("input_tokens"))
                out = count(iteration.get("output_tokens"))
                if net is None or out is None:
                    batch.warnings.append("Advisor usage has incomplete token counters")
                    continue
                events[advisor_key] = UsageEvent(
                    key=advisor_key, timestamp_us=when, harness=self.harness,
                    session_id=session, source_file=path,
                    parent_session_id=parent, turn_id=turn_id,
                    model=iteration.get("model") or route, project=record.get("cwd"),
                    agent_type="advisor", purpose="advisor",
                    input_net=net, output=out,
                    cache_read=count(iteration.get("cache_read_input_tokens"), 0),
                    cache_write=count(iteration.get("cache_creation_input_tokens")))
        batch.events = list(events.values())
        current["first_times"] = first_times
        current["conversation"] = ledger.flush(
            batch, structurally_complete=not any("Invalid JSON" in item for item in batch.warnings))
        return batch
