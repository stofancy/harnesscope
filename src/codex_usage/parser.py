"""rollout 会话文件解析：从 ~/.codex/sessions 的 JSONL 提取会话与逐模型 token 用量。

解析口径（实测钉死的事实，改这里前先看 tests/fixtures 的样例）：
- 会话 ID 取文件名 UUID；`rollout-<ts>-<A>_<B>.jsonl` 且 thread_source=subagent 时，
  A 是父线程、B 是子代理本尊；非 subagent 的同线程多文件（分页）按 ID 合并。
- 子代理文件的 session_meta.session_id 存的是父线程 ID，不可作会话 ID。
- input_tokens 是含缓存的毛值，净输入 = input - cached_input。
- token 计量以每轮 token_count.total_token_usage 的**增量**为准（当前累计 − 上一累计）并按当时
  turn_context 的模型归因：重复帧增量 0 天然不重计；首帧若整块是继承的父线程历史（last 为 0）
  则不计；中间跳升大于该轮 last 时用 last 封顶；累计回落（上下文压缩重置）或缺累计值时回退
  last_token_usage。last 的累加值留在 Session.delta_sum 供交叉校验。
- 档位（Session.tiers）取自 thread_settings_applied 的 service_tier，供 priority/Fast 倍率定价。
- 时间过滤按逐轮事件时间戳（UTC→本地时间）判定，跨窗口会话只统计窗口内的轮次；文件准入除了
  [since,until] 覆盖的日期目录，还要补扫 mtime ≥ since 的 rollout 文件——路径日期更早但窗口内
  仍在写轮次的长会话就在那些目录里（实测漏扫会少算约 62.8M tokens）。
"""

import glob
import json
import os
import re
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta
from collections import defaultdict

from .domain import (ParseBatch, TimingSample, ToolCall, TurnRecord, UsageEvent,
                     timestamp_us as _timestamp_us)

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TYPE_SHORT = {"user": "user", "subagent": "subagent", "guardian_review": "guardian",
              "voice_chat": "voice", "chatgpt_handoff": "handoff",
              "agent_created_thread": "agent"}


@dataclass
class Session:
    file: str
    sid: str
    uuids: list[str]
    type: str | None = None
    parent: str | None = None
    agent: str | None = None
    start: str | None = None
    cwd: str | None = None
    # model -> [gross_in, cached, out, reasoning, calls]
    models: dict[str, list[int]] = field(default_factory=dict)
    # model -> 计量档位（thread_settings_applied 的 service_tier 原值；没出现过则 "unknown"）
    #         -> [gross_in, cached, out, reasoning, calls]，用于 priority/Fast 档倍率定价
    tiers: dict[str, dict[str, list[int]]] = field(default_factory=dict)
    # model -> [timed output tokens, completed turn seconds]; end-to-end timing
    timing: dict[str, list[float]] = field(default_factory=dict)
    # 旧口径（逐轮 last_token_usage 累加，毛输入+输出）对照值
    delta_sum: int = 0
    # 诊断：累计值下降（上下文压缩重置）次数、缺 total_token_usage 回退次数
    resets: int = 0
    fallbacks: int = 0
    first_local: datetime | None = None
    last_local: datetime | None = None
    final_total: list[int] | None = None
    primary_model: str = "unknown"
    multi_model: bool = False


def to_local(ts) -> datetime | None:
    """ISO 时间戳（UTC）→ 本地 naive datetime。"""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        if dt.tzinfo:
            dt = dt.astimezone()
        return dt.replace(tzinfo=None)
    except Exception:
        return None


def parse_time_arg(s: str, end: bool = False) -> datetime:
    """解析 --since/--until。

    支持 "2026-09-12[ 16:10[:23]]"（T 可代空格）与紧凑 "20260912[-16[10[23]]]"
    （分隔符可用 - _ 空格 . T，时间也可写 16:10[:23]）；缺省部分 since 补 0，
    until 补满（23:59:59 / 分秒 59）。
    """
    s = s.strip()
    # 不用 %Y%m%d：它会把 "2026091"（7 位）宽松解析成 2026-09-01；
    # 8 位纯日期由下面的紧凑分支严格处理
    for f in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M",
              "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, f)
            if end:                             # 与紧凑格式一致：缺省部分补满
                if "%S" not in f:
                    dt = dt.replace(second=59)
                if "%M" not in f:
                    dt = dt.replace(minute=59)
                if "%H" not in f:
                    dt = dt.replace(hour=23)
            return dt
        except ValueError:
            continue
    m = re.match(r"(\d{8})(?:[-_ T.]?(\d{2}:\d{2}(?::\d{2})?)?(\d{6}|\d{4}|\d{2})?)?$", s)
    if m:
        y, mo, dd = int(m.group(1)[:4]), int(m.group(1)[4:6]), int(m.group(1)[6:8])
        h = mi = se = 0
        if m.group(2):                      # HH[:MM[:SS]]（MM/SS 均可省略）
            g = m.group(2)
            h = int(g[:2])
            mi = int(g[3:5]) if len(g) > 2 else 0
            se = int(g[6:8]) if len(g) > 5 else 0
            prec = 3 if len(g) > 5 else (2 if len(g) > 2 else 1)
        elif m.group(3):                    # 紧凑 HH[MM[SS]]
            t = m.group(3)
            h = int(t[:2])
            mi = int(t[2:4]) if len(t) >= 4 else 0
            se = int(t[4:6]) if len(t) >= 6 else 0
            prec = len(t) // 2
        else:                               # 纯 YYYYMMDD
            prec = 0
        if end:
            if prec < 3:
                se = 59
            if prec < 2:
                mi = 59
            if prec < 1:
                h = 23
        try:
            return datetime(y, mo, dd, h, mi, se)
        except ValueError:
            pass
    raise SystemExit(f"无法解析时间: {s}（支持 2026-09-12[ 16:10[:23]] 或 20260912[-16[10[23]]]）")


def _token(d, key: str) -> int:
    """从 token 分量字典里取非负整数（缺失/None/非数字都按 0）。"""
    try:
        return max(0, int(d.get(key, 0) or 0))
    except (TypeError, ValueError):
        return 0


def parse_rollout(path: str, window: tuple[datetime, datetime] | None = None) -> Session | None:
    """解析单个 rollout 文件；window 内无消耗的会话返回 None。

    计量口径：以 `token_count.payload.info.total_token_usage` 的**增量**为准
    （当前累计 − 上一累计），按当时 `turn_context` 的模型归因。这样：
      * 重复事件/重放的父历史前缀增量为 0，天然不重复计数（实测同一文件里
        逐轮 last 累加会比最终累计高 10.1%，53% 的文件存在重复累计值）；
      * 上下文压缩导致累计值下降时，该轮回退用 last_token_usage；
      * 缺 total_token_usage 时同样回退 last_token_usage，不丢数据。
    `last_token_usage` 的累加值保留在 `delta_sum` 供交叉校验。
    """
    rec, _batch = _parse_rollout(path, window)
    return rec


def parse_codex_file(path: str, offset: int = 0, state: dict | None = None) -> ParseBatch:
    """Read complete appended lines using the same metering algorithm as the CLI.

    Persist ``next_offset`` and ``state`` together. An unfinished final line remains
    unread until its newline is written. Query windows are applied after extraction.
    """
    _rec, batch = _parse_rollout(path, offset=offset, state=state, capture=True)
    return batch


def _codex_boundary_us(value) -> int | None:
    """Codex task boundary counters are Unix seconds; other sources use milliseconds."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return int(value * 1_000_000)
        except (ValueError, OverflowError):
            return None
    return _timestamp_us(value)


class _CodexActivity:
    """Retain only boundary/identity metadata for unfinished turns and tools."""

    def __init__(self, path: str, batch: ParseBatch, state: dict):
        self.path, self.batch = path, batch
        saved = state.get("activity") or {}
        self.active = saved.get("active_turn_id")
        self.turns = {key: TurnRecord(**value) for key, value in (saved.get("turns") or {}).items()}
        self.tools = {key: ToolCall(**value) for key, value in (saved.get("tools") or {}).items()}
        self.partial = set(saved.get("partial_turns") or [])

    def start(self, payload: dict, timestamp, metadata: dict) -> None:
        tid = payload.get("turn_id")
        start = _codex_boundary_us(payload.get("started_at")) or _timestamp_us(timestamp)
        self.active = tid
        if tid is None or start is None:
            return
        turn = self.turns.get(tid) or TurnRecord(
            key=f"turn:{tid}", harness="codex", turn_id=tid, start_us=start,
            source_file=self.path, status="running", root_turn_id=payload.get("root_turn_id"),
            tool_coverage="partial", **metadata)
        self.turns[tid] = turn
        self.batch.turns.append(turn)

    def finish(self, payload: dict, timestamp, status: str, metadata: dict) -> None:
        tid = payload.get("turn_id")
        if tid is None:
            return
        if self.active == tid:
            self.active = None
        turn = self.turns.get(tid)
        if turn is None:
            start = _codex_boundary_us(payload.get("started_at"))
            if start is None:
                self.tools = {key: tool for key, tool in self.tools.items()
                              if tool.turn_id != tid or tool.status == "running"}
                return
            # Completion records can contain exact boundaries even without the start line.
            turn = TurnRecord(key=f"turn:{tid}", harness="codex", turn_id=tid,
                              start_us=start, source_file=self.path, **metadata)
            self.partial.add(tid)
        end = _codex_boundary_us(payload.get("completed_at")) or _timestamp_us(timestamp)
        if end is not None and end < turn.start_us:
            end, status = None, "unknown"
        pending = any(t.turn_id == tid and t.status == "running" for t in self.tools.values())
        coverage = "partial" if tid in self.partial or pending else "complete"
        finished = replace(turn, end_us=end, status=status, tool_coverage=coverage)
        self.batch.turns.append(finished)
        self.turns.pop(tid, None)
        self.partial.discard(tid)
        self.tools = {key: tool for key, tool in self.tools.items()
                      if tool.turn_id != tid or tool.status == "running"}

    def native(self, payload: dict, metadata: dict) -> None:
        tid = payload.get("turn_id")
        if tid is None:
            return
        turn = self.turns.get(tid)
        if turn is not None:
            turn = replace(turn, root_turn_id=payload.get("root_turn_id") or turn.root_turn_id,
                           **metadata)
            self.turns[tid] = turn
            self.batch.turns.append(turn)
        for call_id, tool in list(self.tools.items()):
            if tool.turn_id == tid and tool.session_id != metadata["session_id"]:
                tool = replace(tool, session_id=metadata["session_id"])
                self.tools[call_id] = tool
                self.batch.tool_calls.append(tool)

    def tool(self, payload: dict, timestamp, position: int, session_id: str) -> None:
        kind = payload.get("type")
        call_id = payload.get("call_id")
        if kind in ("function_call", "custom_tool_call"):
            tid = payload.get("turn_id") or self.active
            when = _timestamp_us(timestamp)
            if when is None:
                if tid:
                    self.partial.add(tid)
                return
            # Call-record status describes generated arguments, not tool execution.
            name = payload.get("name") or "unknown"
            namespace = payload.get("namespace")
            if namespace:
                name = f"{namespace}.{name}"
            identity = call_id or f"{self.path}:{position}"
            if not call_id or tid is None:
                if self.active:
                    self.partial.add(self.active)
            turn = self.turns.get(tid)
            owner = turn.session_id if turn else session_id
            tool = self.tools.get(identity) or ToolCall(
                key=f"call:{identity}", harness="codex", session_id=owner,
                tool_name=name, start_us=when, turn_id=tid, status="running", source_file=self.path)
            self.tools[identity] = tool
            self.batch.tool_calls.append(tool)
        elif kind in ("function_call_output", "custom_tool_call_output"):
            matched_tool = self.tools.get(call_id)
            if matched_tool is None:
                if self.active:
                    self.partial.add(self.active)
                return
            tool = matched_tool
            when = _timestamp_us(timestamp)
            if when is not None and when < tool.start_us:
                when = None
            # Only explicit machine-readable failure flags qualify as errors.
            failed = payload.get("is_error") is True or payload.get("status") in ("error", "failed")
            output = payload.get("output")
            if isinstance(output, dict):
                failed = failed or output.get("is_error") is True
            tool = replace(tool, end_us=when, status="error" if failed else "completed")
            self.batch.tool_calls.append(tool)
            if tool.turn_id in self.turns or (tool.turn_id is not None and tool.turn_id == self.active):
                self.tools[call_id] = tool
            else:
                self.tools.pop(call_id, None)

    def save(self) -> dict:
        return {"active_turn_id": self.active,
                "turns": {key: asdict(turn) for key, turn in self.turns.items()},
                "tools": {key: asdict(tool) for key, tool in self.tools.items()},
                "partial_turns": sorted(self.partial)}


def _parse_rollout(path: str, window: tuple[datetime, datetime] | None = None, *,
                   offset: int = 0, state: dict | None = None,
                   capture: bool = False) -> tuple[Session | None, ParseBatch]:
    state = dict(state or {})
    batch = ParseBatch(next_offset=offset, state=state)
    activity = _CodexActivity(path, batch, state) if capture else None
    uuids = UUID_RE.findall(os.path.basename(path))
    if not uuids:
        return None, batch
    rec = Session(file=path, sid=uuids[0], uuids=uuids)
    for key in ("sid", "type", "parent", "agent", "start", "cwd"):
        if key in state:
            setattr(rec, key, state[key])
    provider = state.get("provider")
    agent_type = state.get("agent_type")
    # Rollout filenames identify the persistent thread. Later session_meta.id
    # values may identify a resumed runtime session while native thread_id stays put.
    web_session_id = rec.sid
    logical_metadata_seen = state.get("logical_metadata_seen", offset > 0)
    native_owners = set(state.get("native_owners") or [])
    native_mirror_pending = state.get("native_mirror_pending", False)
    owner_settings = dict(state.get("owner_settings") or {})
    seen_responses = set(state.get("seen_responses") or [])
    web_turn_outputs: dict[str, int] = dict(state.get("web_turn_outputs") or {})
    web_turn_session = state.get("web_turn_session") or rec.sid
    per_model: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0, 0])
    prev_total: list[int] | None = state.get("prev_total")
    turn_start = to_local(state.get("turn_started_at"))
    turn_start_us = _timestamp_us(state.get("turn_started_at"))
    turn_started_at = state.get("turn_started_at")
    turn_id = state.get("turn_id")
    turn_outputs: dict[str, int] = dict(state.get("turn_outputs") or {})
    turn_in_window = state.get("turn_in_window", True)
    current_model = state.get("current_model", "unknown")
    current_tier = state.get("current_tier", "unknown")
    try:
        fh = open(path, "rb")
    except OSError:
        return None, batch
    with fh:
        fh.seek(offset)
        while True:
            line_offset = fh.tell()
            raw_line = fh.readline()
            if not raw_line or (capture and not raw_line.endswith(b"\n")):
                break
            batch.next_offset = fh.tell()
            batch.records_read += 1
            line = raw_line.decode("utf-8", errors="replace")
            tag = line[:200]
            try:
                if '"session_meta"' in tag:
                    p = json.loads(line).get("payload", {})
                    rec.start = p.get("timestamp") or rec.start
                    rec.cwd = p.get("cwd")
                    provider = p.get("model_provider") or provider
                    ts = p.get("thread_source")
                    if len(uuids) >= 2 and ts == "subagent" and (not capture or not logical_metadata_seen):
                        rec.sid = uuids[1]
                    web_session_id = rec.sid
                    accept_identity = not capture or not logical_metadata_seen or p.get("id") == rec.sid
                    if accept_identity:
                        rec.type = TYPE_SHORT.get(ts, ts)
                    src = p.get("source")
                    if accept_identity and isinstance(src, dict):
                        spawn = (src.get("subagent") or {}).get("thread_spawn") or {}
                        if spawn:
                            rec.parent = spawn.get("parent_thread_id") or uuids[0]
                            nick = spawn.get("agent_nickname") or "?"
                            role = spawn.get("agent_role") or spawn.get("agent_path") or ""
                            agent_type = spawn.get("agent_role") or None
                            rec.agent = f"{nick}({role})" if role else nick
                    logical_metadata_seen = True
                elif '"turn_context"' in tag:
                    context = json.loads(line).get("payload", {})
                    if activity is not None and context.get("turn_id"):
                        activity.active = context["turn_id"]
                    mm = context.get("model")
                    if mm:
                        current_model = mm
                    if context.get("cwd"):
                        rec.cwd = context["cwd"]
                elif '"thread_settings_applied"' in tag:
                    # 每次线程设置变更带 service_tier（default / priority / fast …）；
                    # 顺带用其中的 model 兜底 turn_context 缺失的会话。
                    settings_payload = json.loads(line).get("payload", {}) or {}
                    st = settings_payload.get("thread_settings") or {}
                    settings_owner = settings_payload.get("thread_id") or st.get("thread_id") or web_session_id
                    owner_settings[settings_owner] = st
                    tier = st.get("service_tier")
                    if tier:
                        current_tier = str(tier)
                    if st.get("model") and current_model == "unknown":
                        current_model = st["model"]
                    provider = st.get("model_provider_id") or provider
                elif '"task_started"' in tag:
                    obj = json.loads(line)
                    payload = obj.get("payload", {})
                    if activity is not None:
                        activity.start(payload, obj.get("timestamp"), dict(
                            session_id=web_session_id, parent_session_id=rec.parent,
                            project=rec.cwd, agent_type=agent_type))
                    turn_start = to_local(obj.get("timestamp"))
                    turn_started_at = obj.get("timestamp")
                    turn_start_us = _timestamp_us(turn_started_at)
                    turn_id = obj.get("payload", {}).get("turn_id")
                    turn_outputs = {}
                    web_turn_outputs = {}
                    web_turn_session = web_session_id
                    turn_in_window = (window is None or (turn_start is not None
                                      and window[0] <= turn_start <= window[1]))
                elif '"task_complete"' in tag:
                    obj = json.loads(line)
                    payload = obj.get("payload", {})
                    if activity is not None:
                        activity.finish(payload, obj.get("timestamp"), "completed", dict(
                            session_id=web_session_id, parent_session_id=rec.parent,
                            project=rec.cwd, agent_type=agent_type))
                    end = to_local(obj.get("timestamp"))
                    # A complete, single-model turn is the attribution boundary.
                    # Tool time and waiting are included in this end-to-end rate.
                    if (turn_start is not None and end is not None and turn_id is not None
                            and payload.get("turn_id") == turn_id and turn_in_window
                            and (window is None or window[0] <= end <= window[1])
                            and len(turn_outputs) == 1):
                        seconds = (end - turn_start).total_seconds()
                        if seconds > 0:
                            model, output = next(iter(turn_outputs.items()))
                            sample = rec.timing.setdefault(model, [0.0, 0.0])
                            sample[0] += output
                            sample[1] += seconds
                    end_us = _timestamp_us(obj.get("timestamp"))
                    if (capture and turn_start_us is not None and end_us is not None
                            and end_us > turn_start_us and turn_id is not None
                            and payload.get("turn_id") == turn_id and len(web_turn_outputs) == 1):
                        model, output = next(iter(web_turn_outputs.items()))
                        batch.timing_samples.append(TimingSample(
                            key=f"{web_turn_session}:{turn_id}:turn", harness="codex",
                            session_id=web_turn_session, model=model, start_us=turn_start_us,
                            end_us=end_us, output=output, source_file=path, provider=provider,
                            turn_id=turn_id))
                    turn_start = None
                    turn_started_at = None
                    turn_start_us = None
                    turn_id = None
                    turn_outputs = {}
                    web_turn_outputs = {}
                elif '"turn_aborted"' in tag and activity is not None:
                    obj = json.loads(line)
                    payload = obj.get("payload") or {}
                    activity.finish(payload, obj.get("timestamp"), "aborted", dict(
                        session_id=web_session_id, parent_session_id=rec.parent,
                        project=rec.cwd, agent_type=agent_type))
                    if payload.get("turn_id") == turn_id:
                        turn_start, turn_started_at, turn_start_us, turn_id = None, None, None, None
                        turn_outputs, web_turn_outputs = {}, {}
                elif '"response_item"' in tag and activity is not None:
                    obj = json.loads(line)
                    activity.tool(obj.get("payload") or {}, obj.get("timestamp"),
                                  line_offset, web_session_id)
                elif '"token_usage_record"' in tag and capture:
                    obj = json.loads(line)
                    payload = obj.get("payload") or {}
                    usage = payload.get("usage")
                    if not isinstance(usage, dict):
                        continue
                    owner = payload.get("thread_id") or payload.get("session_id") or web_session_id
                    native_owners.add(owner)
                    native_mirror_pending = True
                    # Native response identity survives archived/copied conversation histories.
                    response_id = payload.get("response_id")
                    if response_id and response_id in seen_responses:
                        continue
                    event_us = _timestamp_us(obj.get("timestamp"))
                    if event_us is None:
                        batch.warnings.append(f"Missing native usage timestamp at byte {line_offset}")
                        continue
                    if response_id:
                        seen_responses.add(response_id)
                    gross = _token(usage, "input_tokens")
                    cached = _token(usage, "cached_input_tokens")
                    written = _token(usage, "cache_write_input_tokens")
                    output = _token(usage, "output_tokens")
                    own_settings = owner_settings.get(owner) or {}
                    if activity is not None:
                        activity.native(payload, dict(
                            session_id=owner,
                            parent_session_id=rec.parent if owner == web_session_id else None,
                            project=rec.cwd if owner == web_session_id else None,
                            agent_type=agent_type if owner == web_session_id else None))
                    batch.events.append(UsageEvent(
                        key=f"response:{response_id}" if response_id else f"{path}:{line_offset}",
                        timestamp_us=event_us, harness="codex", session_id=owner,
                        source_file=path,
                        parent_session_id=rec.parent if owner == web_session_id else None,
                        provider=own_settings.get("model_provider_id") or (
                            provider if owner == web_session_id else None),
                        model=current_model, project=rec.cwd if owner == web_session_id else None,
                        agent_type=agent_type if owner == web_session_id else None,
                        agent_label=rec.agent if owner == web_session_id else None,
                        purpose=rec.type if owner == web_session_id else None,
                        service_tier=own_settings.get("service_tier") or (
                            current_tier if owner == web_session_id else None),
                        input_net=gross - cached - written, cache_read=cached,
                        cache_write=written, output=output,
                        reasoning=_token(usage, "reasoning_output_tokens"),
                        turn_id=payload.get("turn_id"),
                        source_total=_token(usage, "total_tokens")
                        if "total_tokens" in usage else gross + output))
                    if turn_start is not None and payload.get("turn_id") == turn_id:
                        web_turn_session = owner
                        web_turn_outputs[current_model] = web_turn_outputs.get(current_model, 0) + output
                elif '"token_count"' in tag:
                    obj = json.loads(line)
                    info = obj.get("payload", {}).get("info") or {}
                    tl = to_local(obj.get("timestamp"))
                    if window is not None:
                        ws, we = window
                        if tl is None or not (ws <= tl <= we):
                            turn_in_window = False
                            continue
                    if tl:
                        if rec.first_local is None or tl < rec.first_local:
                            rec.first_local = tl
                        if rec.last_local is None or tl > rec.last_local:
                            rec.last_local = tl
                    last_obj = info.get("last_token_usage")
                    last_u = last_obj or {}
                    last_v = [_token(last_u, "input_tokens"), _token(last_u, "cached_input_tokens"),
                              _token(last_u, "output_tokens"),
                              _token(last_u, "reasoning_output_tokens")]
                    if last_v[0] or last_v[2]:                  # 旧口径对照（毛输入 + 输出）
                        rec.delta_sum += last_v[0] + last_v[2]
                    total = info.get("total_token_usage")
                    mirrored_native = native_mirror_pending and (last_obj is not None or bool(total))
                    if mirrored_native:
                        native_mirror_pending = False
                    if total:
                        cur = [_token(total, "input_tokens"), _token(total, "cached_input_tokens"),
                               _token(total, "output_tokens"),
                               _token(total, "reasoning_output_tokens")]
                        rec.final_total = cur[:3]
                        if prev_total is None:
                            # 首帧累计值可能整块是**继承的父线程历史**（实测有文件首帧
                            # 14,051,760 而 last 全 0）：只计它自己的增量，否则会虚高数十倍。
                            delta = last_v if last_obj is not None else cur
                        else:
                            inc = [c - p for c, p in zip(cur, prev_total)]
                            if any(x < 0 for x in inc):
                                rec.resets += 1                 # 压缩重置：累计值回落
                                delta = (last_v if last_obj is not None
                                         else [max(0, x) for x in inc])
                            elif last_obj is not None and any(last_v):
                                # 正常帧「累计增量 == last」；跳升远大于 last 说明中间插入了
                                # 继承历史，用 last 封顶（分量为 0 时仍取增量，不少算）。
                                delta = [min(max(0, x), cap) if cap else max(0, x)
                                         for x, cap in zip(inc, last_v)]
                            else:
                                delta = [max(0, x) for x in inc]
                        prev_total = cur
                    else:
                        rec.fallbacks += 1                       # 缺累计值：回退逐轮增量
                        delta = last_v
                    if any(delta):
                        if turn_start is not None:
                            turn_outputs[current_model] = (turn_outputs.get(current_model, 0)
                                                           + max(0, delta[2]))
                        slot = per_model[current_model]
                        slot[4] += 1                             # 一次 API 调用（有效轮次）
                        for i in range(4):
                            slot[i] += max(0, delta[i])
                        tslot = rec.tiers.setdefault(current_model, {}).setdefault(
                            current_tier, [0, 0, 0, 0, 0])
                        tslot[4] += 1
                        for i in range(4):
                            tslot[i] += max(0, delta[i])
                        if capture and web_session_id not in native_owners and not mirrored_native:
                            timestamp_us = _timestamp_us(obj.get("timestamp"))
                            if timestamp_us is None:
                                batch.warnings.append(f"Missing usage timestamp at byte {line_offset}")
                            else:
                                gross, cached, output, reasoning = delta
                                batch.events.append(UsageEvent(
                                    key=f"{path}:{line_offset}", timestamp_us=timestamp_us,
                                    harness="codex", session_id=web_session_id, source_file=path,
                                    parent_session_id=rec.parent, provider=provider,
                                    model=current_model, project=rec.cwd, agent_type=agent_type,
                                    agent_label=rec.agent, purpose=rec.type,
                                    service_tier=current_tier, input_net=gross - cached,
                                    cache_read=cached, cache_write=0, output=output, reasoning=reasoning,
                                    source_total=gross + output,
                                    turn_id=activity.active if activity is not None else None))
                                if turn_start is not None:
                                    web_turn_outputs[current_model] = web_turn_outputs.get(current_model, 0) + output
            except (json.JSONDecodeError, AttributeError, TypeError):
                continue
    batch.state = {
        **{key: getattr(rec, key) for key in ("sid", "type", "parent", "agent", "start", "cwd")},
        "provider": provider, "agent_type": agent_type, "prev_total": prev_total,
        "current_model": current_model, "current_tier": current_tier,
        "turn_started_at": turn_started_at, "turn_id": turn_id,
        "turn_outputs": turn_outputs, "turn_in_window": turn_in_window,
        "metering_mode": "native" if web_session_id in native_owners else "legacy",
        "web_session_id": web_session_id, "native_owners": sorted(native_owners),
        "logical_metadata_seen": logical_metadata_seen,
        "native_mirror_pending": native_mirror_pending,
        "owner_settings": owner_settings,
        "seen_responses": sorted(seen_responses),
        "web_turn_outputs": web_turn_outputs, "web_turn_session": web_turn_session,
        "activity": activity.save() if activity is not None else {},
    }
    # 只保留有 token 消耗的模型槽位：calls 槽不计入，否则「无 turn_context + 零 token」
    # 的 token_count 事件会带出一个全 0 的 unknown 模型行（旧版口径按 token 分量过滤）
    active = {k: v for k, v in per_model.items() if sum(v[:4]) > 0}
    if not active:
        return None, batch
    rec.models = dict(active)
    rec.primary_model = max(active, key=lambda k: sum(active[k][:3]))
    rec.multi_model = len(active) > 1
    return rec, batch


def collect(sessions_dir: str, since: datetime, until: datetime,
            archive_dir: str | None = None, raw: bool = False) -> list[Session]:
    """扫描日期范围内的 rollout 文件并解析；raw=True 时不合并同 ID 分页文件。"""
    days = []
    d = since.date()
    while d <= until.date():
        days.append(d.strftime("%Y/%m/%d"))
        d += timedelta(days=1)
    paths = []
    for day in days:
        paths += glob.glob(os.path.join(sessions_dir, day, "rollout-*.jsonl"))
    # 跨日长会话：文件落在更早的日期目录里，但窗口内仍在写轮次（实测漏扫 3 个文件
    # 合计 62.8M tokens，补上后与 ccusage 逐 (天,模型) 完全一致）。用 mtime ≥ since
    # 兜住；parse_rollout 的 window 仍只统计窗口内的事件，不会多算。
    if os.path.isdir(sessions_dir):
        cutoff = since.timestamp()
        for root_, _dirs, files_ in os.walk(sessions_dir):
            for fn in files_:
                if not (fn.startswith("rollout-") and fn.endswith(".jsonl")):
                    continue
                p = os.path.join(root_, fn)
                try:
                    if os.path.getmtime(p) >= cutoff:
                        paths.append(p)
                except OSError:
                    continue
    if archive_dir:
        # sessions/ 与 archived_sessions/ 可能同时保存同一会话（文件名 UUID 相同）：
        # 以 sessions/ 为准，否则按 sid 合并会把同一份用量累加两次。
        active_keys = {tuple(UUID_RE.findall(os.path.basename(p))) for p in paths}
        for p in glob.glob(os.path.join(archive_dir, "rollout-*.jsonl")):
            if tuple(UUID_RE.findall(os.path.basename(p))) in active_keys:
                continue
            paths.append(p)
    recs = []
    for p in sorted(set(paths)):
        r = parse_rollout(p, window=(since, until))
        if not r:
            continue
        if raw:
            r.sid = r.uuids[-1]              # 每个文件一行，末位 UUID 区分分页
        recs.append(r)
    if raw:
        return recs
    merged: dict[str, Session] = {}
    for r in recs:
        old = merged.get(r.sid)
        if not old:
            merged[r.sid] = r
            continue
        for mname, v in r.models.items():
            slot = old.models.setdefault(mname, [0, 0, 0, 0, 0])
            for i in range(5):
                slot[i] += v[i]
        for mname, tiers in r.tiers.items():     # 分页文件同样要合并档位明细，否则
            dest = old.tiers.setdefault(mname, {})   # tiers 合计会小于 models（实测差 4.81M 毛输入）
            for tname, tslot in tiers.items():
                dslot = dest.setdefault(tname, [0, 0, 0, 0, 0])
                for i in range(5):
                    dslot[i] += tslot[i]
        for model, sample in r.timing.items():
            dest_sample = old.timing.setdefault(model, [0.0, 0.0])
            for i in range(2):
                dest_sample[i] += sample[i]
        old.delta_sum += r.delta_sum
        old.resets += r.resets
        old.fallbacks += r.fallbacks
        old.parent = old.parent or r.parent
        old.agent = old.agent or r.agent
        old.multi_model = len(old.models) > 1
        old.primary_model = max(old.models, key=lambda k: sum(old.models[k][:3]))
    return list(merged.values())
