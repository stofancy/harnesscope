"""Synthetic Codex events: the web ledger and CLI share legacy metering."""

import json
from dataclasses import replace

import pytest

from harnesscope.adapters.codex import CodexAdapter
from harnesscope.domain import ParseBatch, SourceFile, UsageEvent, timestamp_us
from harnesscope.index import SQLiteIndex
from harnesscope.parser import parse_codex_file, parse_rollout

SID = "00000000-0000-0000-0000-000000000001"
PARENT = "00000000-0000-0000-0000-000000000002"
RUNTIME = "00000000-0000-0000-0000-000000000003"


def record(kind, payload, second=0, day=1):
    return json.dumps({"timestamp": f"2026-10-{day:02d}T23:59:{second:02d}Z",
                       "type": kind, "payload": payload})


def usage(gross=100, cache=20, output=10, reasoning=0):
    return {"input_tokens": gross, "cached_input_tokens": cache,
            "output_tokens": output, "reasoning_output_tokens": reasoning}


def legacy(total, last, second=5, day=1):
    info = {"last_token_usage": last}
    if total is not None:
        info["total_token_usage"] = total
    return record("event_msg", {"type": "token_count", "info": info}, second, day)


def native(response="r1", u=None, second=5, owner=SID, turn="t"):
    return record("token_usage_record", {"response_id": response, "thread_id": owner,
                  "turn_id": turn, "usage": u or usage()}, second)


def context():
    return [record("session_meta", {"id": SID, "model_provider": "local",
                    "thread_source": "user", "cwd": "/synthetic"}),
            record("turn_context", {"model": "gpt-example"})]


def resumed_subagent():
    return [record("session_meta", {
        "id": SID, "model_provider": "local", "thread_source": "subagent",
        "cwd": "/synthetic", "source": {"subagent": {"thread_spawn": {
            "parent_thread_id": PARENT, "agent_nickname": "worker",
            "agent_role": "executor"}}}}),
        record("session_meta", {"id": RUNTIME, "thread_source": "user",
                               "cwd": "/synthetic", "source": "cli"}),
        record("turn_context", {"model": "gpt-example"})]


def write(tmp_path, lines, suffix=""):
    path = tmp_path / f"rollout-2026-10-01T23-59-00-{SID}{suffix}.jsonl"
    path.write_text("\n".join(lines) + "\n")
    return path


def tokens(events):
    return [sum(e.input_net + e.cache_read + (e.cache_write or 0) for e in events),
            sum(e.cache_read for e in events), sum(e.output for e in events),
            sum(e.reasoning or 0 for e in events)]


def test_events_reuse_legacy_metering_and_keep_cross_day_tiers(tmp_path):
    lines = context() + [
        legacy(usage(1000, 200, 100), usage(0, 0, 0)),  # inherited first snapshot
        legacy(usage(1100, 220, 110), usage()),
        legacy(usage(1100, 220, 110), usage()),  # duplicate
        record("event_msg", {"type": "thread_settings_applied", "thread_settings": {
            "service_tier": "priority"}}, 8),
        legacy(usage(30, 5, 3), usage(30, 5, 3), day=2),  # reset
        legacy(None, usage(40, 10, 4), day=2, second=6),
    ]
    path = write(tmp_path, lines)
    rec = parse_rollout(str(path))
    batch = parse_codex_file(str(path))
    assert tokens(batch.events) == rec.models["gpt-example"][:4] == [170, 35, 17, 0]
    assert len(batch.events) == rec.models["gpt-example"][4] == 3
    assert [e.service_tier for e in batch.events] == ["unknown", "priority", "priority"]
    assert batch.events[0].timestamp_us < timestamp_us("2026-10-02T00:00:00Z")
    assert batch.events[1].timestamp_us > timestamp_us("2026-10-02T00:00:00Z")
    assert batch.events[0].provider == "local"
    assert batch.events[0].project == "/synthetic"
    assert all(e.cache_write == 0 for e in batch.events)


def test_resumed_parser_retains_total_model_tier_and_partial_line(tmp_path):
    path = write(tmp_path, context() + [legacy(usage(), usage())])
    first = parse_codex_file(str(path))
    added = record("event_msg", {"type": "thread_settings_applied", "thread_settings": {
        "service_tier": "fast"}}, 6) + "\n" + legacy(usage(160, 30, 16), usage(60, 10, 6), 8)
    with path.open("a") as stream:
        stream.write(added)  # last line is still being written
    second = parse_codex_file(str(path), first.next_offset, json.loads(json.dumps(first.state)))
    assert second.events == []
    assert second.next_offset < path.stat().st_size
    with path.open("a") as stream:
        stream.write("\n")
    third = parse_codex_file(str(path), second.next_offset, second.state)
    assert tokens(third.events) == [60, 10, 6, 0]
    assert third.events[0].service_tier == "fast"
    assert third.events[0].model == "gpt-example"
    assert third.next_offset == path.stat().st_size
    assert tokens(first.events + third.events) == tokens(parse_codex_file(str(path)).events)


def test_complete_turn_timing_survives_refresh_and_is_independent(tmp_path):
    path = write(tmp_path, context() + [record("event_msg", {
        "type": "task_started", "turn_id": "t"}, 1), legacy(usage(), usage())])
    first = parse_codex_file(str(path))
    assert first.timing_samples == []
    with path.open("a") as stream:
        stream.write(record("event_msg", {"type": "task_complete", "turn_id": "t"}, 11) + "\n")
    second = parse_codex_file(str(path), first.next_offset, first.state)
    assert second.events == []
    sample = second.timing_samples[0]
    assert sample.output == 10
    assert sample.end_us - sample.start_us == 10_000_000
    assert sample.kind == "end_to_end"


@pytest.mark.parametrize("change", ["missing_start", "wrong_id", "mixed_model", "zero_time"])
def test_invalid_timing_stays_unknown(tmp_path, change):
    lines = context()
    if change != "missing_start":
        lines += [record("event_msg", {"type": "task_started", "turn_id": "t"}, 1)]
    lines += [legacy(usage(), usage())]
    if change == "mixed_model":
        lines += [record("turn_context", {"model": "other"}, 6),
                  legacy(usage(200, 40, 20), usage(), 7)]
    lines += [record("event_msg", {"type": "task_complete",
              "turn_id": "wrong" if change == "wrong_id" else "t"},
              1 if change == "zero_time" else 11)]
    batch = parse_codex_file(str(write(tmp_path, lines)))
    assert batch.events
    assert batch.timing_samples == []


def test_native_and_legacy_mirror_count_once_and_native_ids_deduplicate(tmp_path):
    lines = context() + [record("event_msg", {"type": "task_started", "turn_id": "t"}, 1),
                         native(), legacy(usage(), usage()), native(),
                         record("event_msg", {"type": "task_complete", "turn_id": "t"}, 11)]
    batch = parse_codex_file(str(write(tmp_path, lines)))
    assert tokens(batch.events) == [100, 20, 10, 0]
    assert len(batch.events) == 1
    assert batch.events[0].key == "response:r1"
    assert batch.timing_samples[0].output == 10


def test_upgrade_preserves_legacy_history_and_then_uses_native(tmp_path):
    path = write(tmp_path, context() + [legacy(usage(), usage())])
    first = parse_codex_file(str(path))
    with path.open("a") as stream:
        stream.write(native(u=usage(50, 5, 20)) + "\n")
        stream.write(legacy(usage(150, 25, 30), usage(50, 5, 20)) + "\n")
    second = parse_codex_file(str(path), first.next_offset, first.state)
    whole = parse_codex_file(str(path))
    assert tokens(whole.events) == tokens(first.events + second.events) == [150, 25, 30, 0]
    assert len(whole.events) == 2


def test_native_owner_cache_write_and_response_identity_survive_copy(tmp_path):
    u = {**usage(100, 20, 10), "cache_write_input_tokens": 5, "total_tokens": 110}
    lines = context() + [native(u=u, owner=PARENT)]
    first = parse_codex_file(str(write(tmp_path, lines)))
    second = parse_codex_file(str(write(tmp_path, lines, "_" + PARENT)))
    event = first.events[0]
    assert event.session_id == PARENT
    assert event.input_net == 75
    assert event.cache_write == 5
    assert event.source_total == 110
    assert event.key == second.events[0].key
    assert event.parent_session_id is None
    assert event.agent_type is None
    assert event.agent_label is None
    assert event.project is None
    assert event.provider is None
    assert event.service_tier is None


def test_resumed_subagent_retains_thread_identity_and_origin(tmp_path):
    path = write(tmp_path, resumed_subagent() + [native()])
    batch = parse_codex_file(str(path))
    event = batch.events[0]
    assert event.session_id == batch.state["web_session_id"] == batch.state["sid"] == SID
    assert event.parent_session_id == PARENT
    assert event.agent_type == "executor"
    assert event.agent_label == "worker(executor)"
    assert event.purpose == "subagent"
    assert event.project == "/synthetic"
    assert tokens(batch.events) == [100, 20, 10, 0]


def test_resume_metadata_after_refresh_retains_original_subagent_origin(tmp_path):
    path = write(tmp_path, resumed_subagent()[:1])
    first = parse_codex_file(str(path))
    with path.open("a") as stream:
        stream.write("\n".join(resumed_subagent()[1:] + [native()]) + "\n")
    second = parse_codex_file(str(path), first.next_offset, first.state)
    assert second.events[0].parent_session_id == PARENT
    assert second.events[0].agent_type == "executor"
    assert second.events[0].purpose == "subagent"
    assert second.state["web_session_id"] == SID


def test_codex_version_rebuild_recovers_old_runtime_state_only_for_codex(tmp_path):
    home = tmp_path / "codex"
    directory = home / "sessions"
    directory.mkdir(parents=True)
    source = write(directory, resumed_subagent() + [native()])
    other_path = tmp_path / "other.txt"
    other_path.write_text("synthetic\n")

    class LegacyCodex(CodexAdapter):
        version = "1"

        def parse_file(self, path, offset=0, state=None):
            batch = super().parse_file(path, offset, state)
            batch.events = [replace(e, parent_session_id=None, agent_type=None,
                                    agent_label=None, purpose=None) for e in batch.events]
            batch.state["web_session_id"] = RUNTIME
            batch.state["type"] = "user"
            batch.state.pop("logical_metadata_seen", None)
            return batch

    class OtherAdapter:
        harness = "claude"
        calls = 0

        def discover(self):
            yield SourceFile(str(other_path), self.harness)

        def parse_file(self, path, offset=0, state=None):
            self.calls += 1
            return ParseBatch(events=[UsageEvent(key="other", timestamp_us=1,
                              harness=self.harness, session_id="other", output=1)],
                              next_offset=other_path.stat().st_size)

    index = SQLiteIndex(tmp_path / "cache.sqlite3")
    other = OtherAdapter()
    index.refresh([LegacyCodex(home), other])
    with index.read_snapshot() as conn:
        assert conn.execute("SELECT parent_session_id FROM events WHERE harness='codex'").fetchone()[0] is None
        assert json.loads(conn.execute("SELECT state FROM files WHERE path=?",
                                      (str(source),)).fetchone()[0])["web_session_id"] == RUNTIME
    refreshed = index.refresh([CodexAdapter(home), other])
    assert refreshed["unchanged_files"] == 1
    assert other.calls == 1
    with index.read_snapshot() as conn:
        event = conn.execute("SELECT * FROM events WHERE harness='codex'").fetchone()
        assert event["parent_session_id"] == PARENT
        assert event["agent_type"] == "executor"
        assert event["purpose"] == "subagent"
        row = conn.execute("SELECT adapter_version,state FROM files WHERE path=?", (str(source),)).fetchone()
        assert row["adapter_version"] == CodexAdapter.version + ":warning-details-v1"
        state = json.loads(row["state"])
    assert state["web_session_id"] == SID
    with source.open("a") as stream:
        stream.write(native(response="r2") + "\n")
    index.refresh([CodexAdapter(home), other])
    with index.read_snapshot() as conn:
        assert conn.execute("SELECT count(*) FROM events WHERE harness='codex' AND parent_session_id=?",
                            (PARENT,)).fetchone()[0] == 2
    assert other.calls == 1


def test_copied_native_mirror_is_suppressed_without_losing_child_legacy(tmp_path):
    path = write(tmp_path, context() + [native(owner=PARENT)])
    first = parse_codex_file(str(path))
    with path.open("a") as stream:
        stream.write(legacy(usage(), usage()) + "\n")
        stream.write(legacy(usage(150, 25, 20), usage(50, 5, 10), 8) + "\n")
    second = parse_codex_file(str(path), first.next_offset, first.state)
    assert len(second.events) == 1
    assert second.events[0].session_id == SID
    assert tokens(second.events) == [50, 5, 10, 0]


def test_native_repeat_across_refresh_does_not_inflate_turn_output(tmp_path):
    path = write(tmp_path, context() + [record("event_msg", {
        "type": "task_started", "turn_id": "t"}, 1), native()])
    first = parse_codex_file(str(path))
    with path.open("a") as stream:
        stream.write(native() + "\n")
        stream.write(legacy(usage(), usage()) + "\n")
        stream.write(record("event_msg", {"type": "task_complete", "turn_id": "t"}, 11) + "\n")
    second = parse_codex_file(str(path), first.next_offset, first.state)
    assert second.events == []
    assert second.timing_samples[0].output == 10


def test_discovery_prefers_active_copy_and_keeps_pagination(tmp_path):
    active = tmp_path / "sessions"
    archive = tmp_path / "archived_sessions"
    active.mkdir()
    archive.mkdir()
    base = write(active, context() + [legacy(usage(), usage())])
    write(archive, context() + [legacy(usage(), usage())])
    page = write(archive, context() + [legacy(usage(), usage())], "_" + PARENT)
    found = list(CodexAdapter(tmp_path).discover())
    assert {s.path for s in found} == {str(base), str(page)}
    assert len({s.identity for s in found}) == 2


def test_discovery_keeps_distinct_active_files_with_same_thread_uuid(tmp_path):
    active = tmp_path / "sessions"
    active.mkdir()
    first = write(active, context() + [legacy(usage(), usage())])
    second = active / first.name.replace("T23-59-00", "T23-58-00")
    second.write_text(first.read_text())
    found = list(CodexAdapter(tmp_path).discover())
    assert len(found) == 2
    assert len({s.identity for s in found}) == 2


def test_cli_still_accepts_complete_last_line_without_newline(tmp_path):
    path = write(tmp_path, context() + [legacy(usage(), usage())])
    path.write_bytes(path.read_bytes().rstrip(b"\n"))
    assert parse_rollout(str(path)).models["gpt-example"][0] == 100
    assert parse_codex_file(str(path)).events == []
