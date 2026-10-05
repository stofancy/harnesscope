"""Read-only JSONL helpers; retain statistical metadata, never conversation text."""

import json
import math
from pathlib import Path

from ..domain import ParseBatch


def count(value, default=None):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else default


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def lines(path: str, offset: int, batch: ParseBatch):
    """Consume only complete lines, including invalid JSON lines with a warning."""
    batch.next_offset = offset
    with Path(path).open("rb") as stream:
        stream.seek(offset)
        while True:
            position = stream.tell()
            raw = stream.readline()
            if not raw or not raw.endswith(b"\n"):
                break
            batch.next_offset = stream.tell()
            if not raw.strip():
                continue
            batch.records_read += 1
            try:
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise ValueError("record must be an object")
            except (ValueError, UnicodeError):
                batch.warnings.append(f"Invalid JSON record at byte {position}")
                continue
            yield position, value


def header(path: str):
    batch = ParseBatch()
    for index, (_, record) in enumerate(lines(path, 0, batch)):
        if record.get("type") == "session":
            return record
        if index >= 20:
            break
    return {}
