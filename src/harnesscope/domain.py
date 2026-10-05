"""Source-independent usage records. Only statistical metadata belongs in this module."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Protocol

from .names import SessionTitle


@dataclass(frozen=True)
class UsageEvent:
    key: str
    timestamp_us: int
    harness: str
    session_id: str
    source_file: str = ""
    parent_session_id: str | None = None
    provider: str | None = None
    model: str = "unknown"
    project: str | None = None
    agent_type: str | None = None
    agent_label: str | None = None
    purpose: str | None = None
    service_tier: str | None = None
    input_net: int = 0
    cache_read: int = 0
    cache_write: int | None = None
    output: int = 0
    reasoning: int | None = None
    source_total: int | None = None
    source_cost_usd: str | None = None
    source_cost_kind: str | None = None
    quality: str = "exact"
    extra_tokens: dict[str, int] = field(default_factory=dict)
    turn_id: str | None = None
    credential_ref: str | None = None
    account_ref: str | None = None


@dataclass(frozen=True)
class TimingSample:
    key: str
    harness: str
    session_id: str
    model: str
    start_us: int
    end_us: int
    output: int
    source_file: str = ""
    kind: str = "end_to_end"
    provider: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class TurnRecord:
    key: str
    harness: str
    session_id: str
    turn_id: str
    start_us: int
    end_us: int | None = None
    status: str = "unknown"
    source_file: str = ""
    parent_session_id: str | None = None
    root_turn_id: str | None = None
    project: str | None = None
    agent_type: str | None = None
    boundary_quality: str = "exact"
    tool_coverage: str = "unknown"


@dataclass(frozen=True)
class ToolCall:
    key: str
    harness: str
    session_id: str
    tool_name: str
    start_us: int
    turn_id: str | None = None
    end_us: int | None = None
    status: str = "unknown"
    source_file: str = ""


@dataclass(frozen=True)
class SourceFile:
    path: str
    harness: str
    source_kind: str = "session"
    # An adapter may identify copied/archived files with the same logical identity.
    identity: str | None = None


@dataclass
class ParseBatch:
    events: list[UsageEvent] = field(default_factory=list)
    timing_samples: list[TimingSample] = field(default_factory=list)
    next_offset: int = 0
    state: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    records_read: int = 0
    turns: list[TurnRecord] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    session_titles: list[SessionTitle] = field(default_factory=list)


class UsageAdapter(Protocol):
    harness: str

    def discover(self) -> Iterable[SourceFile]: ...

    def parse_file(self, path: str, offset: int = 0,
                   state: dict | None = None) -> ParseBatch: ...


def timestamp_us(value: str | int | float | datetime | None) -> int | None:
    """ISO timestamp or epoch milliseconds to UTC microseconds; invalid is unknown."""
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            return int(value * 1000)
        dt = value if isinstance(value, datetime) else datetime.fromisoformat(
            str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1_000_000)
    except (ValueError, TypeError, OverflowError):
        return None
