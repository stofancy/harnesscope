"""OMP's assistant and auxiliary model_usage entries share one usage ledger."""

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from ..domain import ParseBatch, SourceFile, TimingSample, UsageEvent, timestamp_us
from .common import count, finite, header, lines
from .conversation import ConversationLedger


def entry_identity(record):
    """Native chain identity for inherited metadata, without message content."""
    if not record.get("id"):
        return None
    message = record.get("message") or {}
    identity = [record.get("id"), record.get("timestamp"), record.get("type"),
                message.get("role") if isinstance(message, dict) else None]
    return hashlib.sha256(json.dumps(identity).encode()).hexdigest()


def usage_identity(record):
    message = record.get("message") if record.get("type") == "message" else record
    if not isinstance(message, dict):
        return None
    if record.get("type") == "message" and message.get("role") != "assistant":
        return None
    if record.get("type") not in {"message", "model_usage"}:
        return None
    # Entry IDs are short random identifiers; timestamp and route distinguish
    # unrelated entries while exact copied fork entries retain this identity.
    identity = [record.get("id"), record.get("timestamp"), message.get("provider"),
                message.get("model"), message.get("usage")]
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


class OmpAdapter:
    harness = "omp"

    def __init__(self, root: str | Path | None = None):
        default = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".omp/agent")
        self.root = Path(root or os.environ.get("OMP_SESSIONS_DIR") or default / "sessions")
        self._headers: dict[str, dict[str, Any]] = {}
        self._paths: dict[str, str] = {}
        self._ancestors: dict[str, tuple[str | None, dict[str, str]]] = {}
        self._ancestor_entries: dict[str, set[str]] = {}

    def discover(self):
        self._ancestors.clear()
        self._ancestor_entries.clear()
        paths = sorted(self.root.rglob("*.jsonl"))
        for path in paths:
            info = header(str(path))
            self._headers[str(path)] = info
            if info.get("id"):
                self._paths[info["id"]] = str(path)
        for path in paths:
            yield SourceFile(str(path), self.harness)

    def _parent_path(self, parent):
        if not parent:
            return None
        if parent in self._paths:
            return self._paths[parent]
        candidate = Path(parent)
        return str(candidate) if candidate.is_file() else None

    def _lineage(self, path, seen=None):
        """Match inherited metadata to its ancestor owner; no content is retained."""
        seen = set(seen or ())
        if path in seen:
            return None, {}, None
        seen.add(path)
        info = self._headers.get(path) or header(path)
        sid = str(info.get("id") or Path(path).stem)
        parent = info.get("parentSession")
        parent_path = self._parent_path(parent)
        if not parent_path:
            return sid, {}, parent if parent and not Path(parent).is_absolute() else None
        parent_info = self._headers.get(parent_path) or header(parent_path)
        parent_sid = str(parent_info.get("id") or Path(parent_path).stem)
        if parent_path not in self._ancestors:
            root_sid, inherited, _ = self._lineage(parent_path, seen)
            owners = dict(inherited)
            inherited_entries = set()
            ancestor_parent_path = self._parent_path(parent_info.get("parentSession"))
            if ancestor_parent_path:
                inherited_entries.update(self._ancestor_entries.get(ancestor_parent_path, set()))
            ancestor_batch = ParseBatch()
            for _, record in lines(parent_path, 0, ancestor_batch):
                entry = entry_identity(record)
                if entry:
                    inherited_entries.add(entry)
                identity = usage_identity(record)
                if identity:
                    owners.setdefault(identity, parent_sid)
            self._ancestors[parent_path] = root_sid, owners
            self._ancestor_entries[parent_path] = inherited_entries
        root_sid, inherited = self._ancestors[parent_path]
        return root_sid, inherited, parent_sid

    def parse_file(self, path, offset=0, state=None):
        current = dict(state or {})
        info = self._headers.get(path) or header(path)
        sid = str(info.get("id") or Path(path).stem)
        root_sid, inherited, parent = self._lineage(path)
        batch = ParseBatch(state=current)
        ledger = ConversationLedger(self.harness, path, current.get("conversation"))
        project = info.get("cwd")
        tier = current.get("tier")
        try:
            depth = len(Path(path).relative_to(self.root).parts)
        except ValueError:
            depth = 2
        agent_type = ("advisor" if Path(path).name.startswith("__advisor") else
                      "subagent" if depth > 2 else "main")
        parent_path = self._parent_path(info.get("parentSession"))
        inherited_entries = self._ancestor_entries.get(parent_path, set()) if parent_path else set()
        for position, record in lines(path, offset, batch):
            if record.get("type") == "service_tier_change":
                tier = record.get("serviceTier")
            inherited_entry = entry_identity(record)
            if inherited_entry and inherited_entry in inherited_entries:
                continue
            message = (record.get("message") or {} if record.get("type") == "message" else record)
            when = timestamp_us(message.get("timestamp")) or timestamp_us(record.get("timestamp"))
            role = message.get("role") if record.get("type") == "message" else None
            user = (role == "user" and not any(message.get(flag) for flag in (
                "synthetic", "steering", "liveSteered")) and
                message.get("attribution") != "agent" and bool(message.get("content")))
            node_id = record.get("id") or (f"byte:{position}" if user else None)
            turn_id = ledger.observe_node(
                sid, node_id, record.get("parentId"), when, user=user,
                parent=parent, project=project, agent_type=agent_type)
            content = message.get("content")
            if role == "assistant" and isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "toolCall":
                        ledger.call(sid, block.get("id"), block.get("name"), when, turn_id)
            if role == "toolResult":
                ledger.result(sid, message.get("toolCallId"), when,
                              bool(message.get("isError")), turn_id)
            if role == "assistant":
                reason = message.get("stopReason")
                end = timestamp_us(message.get("completedAt")) or when
                if reason in {"stop", "length"}:
                    ledger.finish(sid, turn_id, end, "completed")
                elif reason in {"error", "aborted"}:
                    ledger.finish(sid, turn_id, end, reason)
            identity = usage_identity(record)
            if identity is None:
                continue
            if identity in inherited:
                # The readable ancestor owns the copied call. Keep its index
                # row attached to that source, so deleting a fork cannot erase it.
                continue
            message = record.get("message") if record.get("type") == "message" else record
            usage = message.get("usage")
            if not isinstance(usage, dict):
                batch.warnings.append("Model response has no usage")
                continue
            net, output = count(usage.get("input")), count(usage.get("output"))
            if net is None or output is None:
                batch.warnings.append("Model usage has incomplete token counters")
                continue
            when = timestamp_us(message.get("timestamp")) or timestamp_us(record.get("timestamp"))
            if when is None:
                batch.warnings.append("Model usage has no valid timestamp")
                continue
            owner = inherited.get(identity, sid)
            response_id = message.get("responseId")
            entry = record.get("id")
            # A response ID survives copied history and file relocation.
            key = (f"response:{message.get('provider')}:{response_id}" if response_id else
                   f"entry:{root_sid}:{entry}:{identity}" if entry else f"{sid}:{position}")
            extra = {}
            orchestration = usage.get("orchestration") or {}
            for raw, normalized in [("input", "input"), ("output", "output"),
                                    ("cacheRead", "cache_read")]:
                value = count(orchestration.get(raw))
                if value is not None:
                    extra[f"orchestration_{normalized}"] = value
            cost = usage.get("cost")
            amount = cost.get("total") if isinstance(cost, dict) else None
            valid_cost = amount is not None and finite(amount) and amount >= 0
            batch.events.append(UsageEvent(
                key=key, timestamp_us=when, harness=self.harness,
                session_id=owner, source_file=path, parent_session_id=parent if owner == sid else None,
                turn_id=turn_id,
                provider=message.get("provider"), model=message.get("model") or "unknown",
                project=project, agent_type="main" if owner == root_sid else agent_type,
                agent_label=Path(path).stem if agent_type != "main" else None,
                purpose=record.get("purpose") if record.get("type") == "model_usage" else None,
                service_tier=tier if isinstance(tier, str) else None,
                input_net=net, output=output, cache_read=count(usage.get("cacheRead"), 0),
                cache_write=count(usage.get("cacheWrite")),
                reasoning=count(usage.get("reasoningTokens")), source_total=count(usage.get("totalTokens")),
                source_cost_usd=str(amount) if valid_cost else None,
                source_cost_kind="api_estimate" if valid_cost else None,
                quality="exact" if entry or response_id else "identity_unknown", extra_tokens=extra))
            duration = message.get("duration")
            if finite(duration) and duration > 0:
                end = timestamp_us(message.get("completedAt")) or when + int(duration * 1000)
                batch.timing_samples.append(TimingSample(
                    key=key, harness=self.harness, session_id=owner,
                    model=message.get("model") or "unknown", provider=message.get("provider"),
                    start_us=end - int(duration * 1000), end_us=end,
                    output=output, source_file=path, kind="model", turn_id=turn_id))
        current["tier"] = tier
        current["conversation"] = ledger.flush(
            batch, structurally_complete=not any("Invalid JSON" in item for item in batch.warnings))
        return batch
