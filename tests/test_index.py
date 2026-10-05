"""Index recovery tests use a tiny append-only adapter and isolated source files."""

import json
import os
import threading

from codex_usage.domain import ParseBatch, SourceFile, TimingSample, UsageEvent
from codex_usage.index import SQLiteIndex
from codex_usage.service import UsageService


class Adapter:
    harness = "test"
    version = "1"

    def __init__(self, paths):
        self.paths = paths
        self.reads = []
        self.fail = False

    def discover(self):
        return [SourceFile(str(path), self.harness) for path in self.paths]

    def parse_file(self, path, offset=0, state=None):
        self.reads.append(offset)
        if self.fail:
            raise OSError("private transcript text must not reach status")
        batch = ParseBatch(next_offset=offset, state=dict(state or {}))
        with open(path, "rb") as source:
            source.seek(offset)
            while True:
                raw = source.readline()
                if not raw or not raw.endswith(b"\n"):
                    break
                value = json.loads(raw)
                batch.events.append(UsageEvent(key=value["id"], timestamp_us=value["time"],
                                               harness=self.harness, session_id="s",
                                               model="m", input_net=value["input"]))
                batch.records_read += 1
                batch.next_offset = source.tell()
        batch.state["read_records"] = batch.state.get("read_records", 0) + batch.records_read
        return batch


def record(key="one", timestamp=1, tokens=100):
    return json.dumps({"id": key, "time": timestamp, "input": tokens}).encode() + b"\n"


def totals(index):
    with index.read_snapshot() as conn:
        row = conn.execute("SELECT count(*),coalesce(sum(input_net),0) FROM events").fetchone()
        return tuple(row)


def test_unchanged_files_are_not_reparsed_and_append_resumes(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record())
    adapter = Adapter([source])
    index = SQLiteIndex(tmp_path / "cache" / "usage.sqlite3")
    index.refresh([adapter])
    revision = index.snapshot_id
    assert totals(index) == (1, 100)
    index.refresh([adapter])
    assert adapter.reads == [0]
    assert index.snapshot_id == revision
    with source.open("ab") as output:
        output.write(record("two", 2, 200))
    index.refresh([adapter])
    assert adapter.reads == [0, len(record())]
    assert totals(index) == (2, 300)
    with index.read_snapshot() as conn:
        row = conn.execute("SELECT state FROM files").fetchone()
        assert json.loads(row[0])["read_records"] == 2
    # Reopening uses durable offsets and never reads harness files on a query.
    restored = SQLiteIndex(index.path)
    assert totals(restored) == (2, 300)
    restored.refresh([adapter])
    assert len(adapter.reads) == 2


def test_partial_tail_is_committed_only_after_newline(tmp_path):
    source = tmp_path / "source.jsonl"
    pending = record("two", 2, 200)
    source.write_bytes(record() + pending[:-1])
    adapter = Adapter([source])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    index.refresh([adapter])
    assert totals(index) == (1, 100)
    assert adapter.reads == [0, len(record())]
    with source.open("ab") as output:
        output.write(b"\n")
    index.refresh([adapter])
    assert totals(index) == (2, 300)
    assert adapter.reads[-1] == len(record())


def test_truncation_and_same_size_rewrite_replace_owned_records(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record() + record("two", 2, 200))
    adapter = Adapter([source])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    source.write_bytes(record("new", 3, 300))
    index.refresh([adapter])
    assert totals(index) == (1, 300)
    source.write_bytes(record("new", 3, 400))
    # Force a different timestamp even on coarse filesystems.
    stat = source.stat()
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    index.refresh([adapter])
    assert totals(index) == (1, 400)
    assert adapter.reads == [0, 0, 0]


def test_replacement_with_larger_size_rebuilds_and_removes_previous_ids(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record())
    adapter = Adapter([source])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    replacement = tmp_path / "replacement.jsonl"
    replacement.write_bytes(record("replacement", 5, 400) + record("extra", 6, 600))
    replacement.replace(source)
    index.refresh([adapter])
    assert totals(index) == (2, 1000)
    assert adapter.reads == [0, 0]


def test_source_failure_preserves_previous_snapshot_and_other_sources_update(tmp_path):
    source = tmp_path / "one.jsonl"
    other = tmp_path / "two.jsonl"
    source.write_bytes(record())
    other.write_bytes(record("other", 2, 200))
    first, second = Adapter([source]), Adapter([other])
    second.harness = "second"
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([first, second])
    first.fail = True
    with source.open("ab") as output:
        output.write(record("failed", 3, 300))
    with other.open("ab") as output:
        output.write(record("success", 4, 400))
    result = index.refresh([first, second])
    assert result["failed_files"] == 1
    assert totals(index) == (3, 700)
    status = index.status()
    assert next(s for s in status["sources"] if s["harness"] == "test")["state"] == "partial"
    assert "private transcript" not in json.dumps(status)
    first.fail = False
    index.refresh([first, second])
    assert totals(index) == (4, 1000)


def test_adapter_version_change_rebuilds_and_dedup_is_harness_scoped(tmp_path):
    source = tmp_path / "one.jsonl"
    other = tmp_path / "two.jsonl"
    source.write_bytes(record())
    other.write_bytes(record(tokens=200))
    first, second = Adapter([source]), Adapter([other])
    second.harness = "second"
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([first, second])
    assert totals(index) == (2, 300)
    first.version = "2"
    index.refresh([first, second])
    assert first.reads == [0, 0]
    assert second.reads == [0]
    assert totals(index) == (2, 300)


def test_read_transaction_keeps_snapshot_while_refresh_commits(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record())
    adapter = Adapter([source])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    with index.read_snapshot() as conn:
        assert conn.execute("SELECT count(*) FROM events").fetchone()[0] == 1
        with source.open("ab") as output:
            output.write(record("two", 2, 200))
        thread = threading.Thread(target=index.refresh, args=([adapter],))
        thread.start()
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert conn.execute("SELECT count(*) FROM events").fetchone()[0] == 1
    assert totals(index) == (2, 300)


def test_compressed_style_adapter_replaces_full_projection_on_change(tmp_path):
    source = tmp_path / "generation.bin"
    source.write_bytes(record())
    adapter = Adapter([source])
    adapter.supports_incremental = False
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    source.write_bytes(record("replacement-longer-key", 2, 200))
    index.refresh([adapter])
    assert totals(index) == (1, 200)
    assert adapter.reads == [0, 0]


def test_timing_and_source_files_are_read_only(tmp_path):
    source = tmp_path / "source.jsonl"
    original = record()
    source.write_bytes(original)
    adapter = Adapter([source])
    parse = adapter.parse_file

    def with_timing(path, offset=0, state=None):
        batch = parse(path, offset, state)
        batch.timing_samples.append(TimingSample("turn", "test", "s", "m", 0, 10, 50))
        return batch

    adapter.parse_file = with_timing
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    assert source.read_bytes() == original
    with index.read_snapshot() as conn:
        sample = conn.execute("SELECT * FROM timing_samples").fetchone()
        assert sample["kind"] == "end_to_end"
        assert sample["source_file"] == str(source)
    assert os.stat(index.path).st_mode & 0o777 == 0o600


def test_service_background_refresh_is_single_and_queries_stay_responsive(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record())
    adapter = Adapter([source])
    entered, release = threading.Event(), threading.Event()
    parse = adapter.parse_file

    def blocking(path, offset=0, state=None):
        entered.set()
        assert release.wait(timeout=5)
        return parse(path, offset, state)

    adapter.parse_file = blocking
    service = UsageService(tmp_path / "usage.sqlite3", [adapter])
    try:
        assert service.refresh()["started"]
        assert entered.wait(timeout=5)
        assert service.status()["refreshing"]
        assert not service.refresh()["started"]
        assert totals(service.index) == (0, 0)
        release.set()
        service._thread.join(timeout=5)
        assert not service.refreshing
        assert totals(service.index) == (1, 100)
    finally:
        release.set()
        service.close()


def test_successful_discovery_prunes_deleted_sources(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record())
    adapter = Adapter([source])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    source.unlink()
    adapter.paths = []
    index.refresh([adapter])
    assert totals(index) == (0, 0)


def test_discovery_failure_keeps_previous_source_and_exposes_coverage(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record())
    adapter = Adapter([source])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])

    def failing_discover():
        raise OSError("source unavailable")

    adapter.discover = failing_discover
    index.refresh([adapter])
    assert totals(index) == (1, 100)
    assert index.status()["sources"][0]["state"] == "partial"


def test_relocation_failure_preserves_old_mirror_until_replacement_succeeds(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record())
    adapter = Adapter([source])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    replacement = tmp_path / "archived.jsonl"
    source.replace(replacement)
    adapter.paths = [replacement]
    adapter.fail = True
    index.refresh([adapter])
    assert totals(index) == (1, 100)
    adapter.fail = False
    index.refresh([adapter])
    assert totals(index) == (1, 100)
    with index.read_snapshot() as conn:
        assert conn.execute("SELECT source_file FROM events").fetchone()[0] == str(replacement)


def test_cancellation_stops_before_next_file_without_removing_cached_rows(tmp_path):
    first, second = tmp_path / "first.jsonl", tmp_path / "second.jsonl"
    first.write_bytes(record())
    second.write_bytes(record("two", 2, 200))
    adapter = Adapter([first, second])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    first.write_bytes(record("changed", 3, 300))
    cancel = threading.Event()

    def progress(value):
        if value["files_done"] == 0:
            cancel.set()

    result = index.refresh([adapter], progress=progress, cancel=cancel)
    assert result["cancelled"]
    assert result["files_done"] == 1
    assert totals(index) == (2, 500)


def test_removing_latest_duplicate_file_preserves_unchanged_original(tmp_path):
    first, second = tmp_path / "first.jsonl", tmp_path / "second.jsonl"
    first.write_bytes(record())
    second.write_bytes(record())
    adapter = Adapter([first, second])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    assert totals(index) == (1, 100)
    second.unlink()
    adapter.paths = [first]
    index.refresh([adapter])
    assert adapter.reads == [0, 0]
    assert totals(index) == (1, 100)
    with index.read_snapshot() as conn:
        assert conn.execute("SELECT source_file FROM events").fetchone()[0] == str(first)
        assert conn.execute("SELECT count(*) FROM event_sources").fetchone()[0] == 1
    first.unlink()
    adapter.paths = []
    index.refresh([adapter])
    assert totals(index) == (0, 0)


def test_rebuilding_duplicate_file_does_not_erase_original_call(tmp_path):
    first, second = tmp_path / "first.jsonl", tmp_path / "second.jsonl"
    first.write_bytes(record())
    second.write_bytes(record())
    adapter = Adapter([first, second])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    second.write_bytes(record("replacement", 2, 200))
    index.refresh([adapter])
    assert totals(index) == (2, 300)
    assert adapter.reads == [0, 0, 0]


def test_duplicate_timing_is_retained_when_one_projection_is_deleted(tmp_path):
    first, second = tmp_path / "first.jsonl", tmp_path / "second.jsonl"
    first.write_bytes(record())
    second.write_bytes(record())
    adapter = Adapter([first, second])
    parse = adapter.parse_file

    def timed(path, offset=0, state=None):
        batch = parse(path, offset, state)
        batch.timing_samples.append(TimingSample("turn", "test", "s", "m", 0, 10, 50))
        return batch

    adapter.parse_file = timed
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    second.unlink()
    adapter.paths = [first]
    index.refresh([adapter])
    with index.read_snapshot() as conn:
        assert conn.execute("SELECT count(*) FROM timing_samples").fetchone()[0] == 1
        assert conn.execute("SELECT source_file FROM timing_samples").fetchone()[0] == str(first)


def test_growing_in_place_rewrite_is_detected_by_bounded_fingerprint(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record())
    adapter = Adapter([source])
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    inode = source.stat().st_ino
    source.write_bytes(record("new", 2, 200) + record("extra", 3, 300))
    assert source.stat().st_ino == inode
    index.refresh([adapter])
    assert adapter.reads == [0, 0]
    assert totals(index) == (2, 500)


def test_parser_warnings_make_coverage_partial_without_a_fatal_error(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_bytes(record())
    adapter = Adapter([source])
    parse = adapter.parse_file

    def warning(path, offset=0, state=None):
        batch = parse(path, offset, state)
        batch.warnings.append("Missing usage in another source record")
        return batch

    adapter.parse_file = warning
    index = SQLiteIndex(tmp_path / "usage.sqlite3")
    index.refresh([adapter])
    coverage = index.status()["sources"][0]
    assert coverage["state"] == "partial"
    assert coverage["warnings"] == 1
    assert coverage["error"] is None
