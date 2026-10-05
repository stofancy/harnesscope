"""Synthetic source contracts; no real user transcripts or network access."""

import json

import zstandard

from codex_usage.adapters.claude import ClaudeAdapter
from codex_usage.adapters.dsh import DshAdapter, decode_zstd
from codex_usage.adapters.omp import OmpAdapter


def write(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in records))
    return str(path)


def claude_response(identity="response", output=10, **extra):
    return dict(type="assistant", timestamp="2026-10-04T23:59:59Z", sessionId="session",
                requestId="request", uuid="block", cwd="/project", **extra,
                message=dict(id=identity, model="claude-model", role="assistant",
                             usage=dict(input_tokens=100, output_tokens=output,
                                        cache_read_input_tokens=30,
                                        cache_creation_input_tokens=8,
                                        cache_creation=dict(ephemeral_5m_input_tokens=3,
                                                            ephemeral_1h_input_tokens=5),
                                        output_tokens_details=dict(thinking_tokens=4))))


def test_claude_blocks_upsert_final_usage_and_keep_first_time(tmp_path):
    first = claude_response(output=2)
    final = claude_response(output=10)
    final["timestamp"] = "2026-10-05T00:00:02Z"
    path = write(tmp_path / "session.jsonl", [first, final])
    batch = ClaudeAdapter(tmp_path).parse_file(path)
    assert len(batch.events) == 1
    event = batch.events[0]
    assert (event.input_net, event.cache_read, event.cache_write, event.output) == (100, 30, 8, 10)
    assert event.reasoning == 4
    assert event.extra_tokens == {"cache_write_5m": 3, "cache_write_1h": 5}
    assert event.timestamp_us == 1791158399000000
    assert event.provider is None and event.source_cost_usd is None


def test_claude_subagent_and_advisor_are_independent(tmp_path):
    row = claude_response(agentId="child", isSidechain=True)
    row["message"]["usage"]["iterations"] = [
        dict(type="ordinary", input_tokens=100, output_tokens=10),
        dict(type="advisor_message", model="advisor-model", input_tokens=5, output_tokens=3)]
    batch = ClaudeAdapter(tmp_path).parse_file(write(tmp_path / "a.jsonl", [row]))
    assert len(batch.events) == 2
    assert batch.events[0].session_id == "session/child"
    assert batch.events[0].parent_session_id == "session"
    assert batch.events[1].purpose == "advisor"
    assert batch.events[1].model == "advisor-model"
    assert sum(event.output for event in batch.events) == 13


def test_claude_incremental_content_updates_and_partial_tail(tmp_path):
    path = tmp_path / "a.jsonl"
    write(path, [claude_response(output=2)])
    adapter = ClaudeAdapter(tmp_path)
    first = adapter.parse_file(str(path))
    raw = json.dumps(claude_response(output=10)).encode()
    with path.open("ab") as stream:
        stream.write(raw[:15])
    partial = adapter.parse_file(str(path), first.next_offset, first.state)
    assert not partial.events and partial.next_offset == first.next_offset
    with path.open("ab") as stream:
        stream.write(raw[15:] + b"\n")
    final = adapter.parse_file(str(path), partial.next_offset, partial.state)
    assert final.events[0].key == first.events[0].key
    assert final.events[0].output == 10
    assert final.events[0].timestamp_us == first.events[0].timestamp_us


def omp_record(identity="entry", **extra):
    return dict(type="message", id=identity, parentId="previous-entry",
                timestamp="2026-10-04T12:00:00Z", **extra,
                message=dict(role="assistant", provider="route", model="model", api="api",
                             timestamp=1791115200000, completedAt=1791115202000,
                             duration=2000, ttft=100, responseId="response-" + identity,
                             usage=dict(input=10, cacheRead=20, cacheWrite=3, output=4,
                                        reasoningTokens=2, totalTokens=37, cost=dict(total=0.5))))


def test_omp_auxiliary_usage_and_native_duration(tmp_path):
    auxiliary = dict(type="model_usage", id="aux", parentId="previous-entry",
                     timestamp="2026-10-05T12:00:00Z", provider="route", model="find-model",
                     purpose="find", api="api", usage=dict(input=7, output=2, cacheRead=0))
    path = write(tmp_path / "project" / "s.jsonl", [
        dict(type="title", title="not retained"),
        dict(type="session", id="s", version=3, cwd="/project"), omp_record(), auxiliary])
    batch = OmpAdapter(tmp_path).parse_file(path)
    assert len(batch.events) == 2 and batch.events[1].purpose == "find"
    assert batch.events[1].cache_write is None
    assert batch.events[0].parent_session_id is None
    assert batch.events[0].source_cost_usd == "0.5"
    assert batch.events[0].source_cost_kind == "api_estimate"
    assert len(batch.timing_samples) == 1 and batch.timing_samples[0].kind == "model"
    assert batch.timing_samples[0].end_us - batch.timing_samples[0].start_us == 2000000
    assert "not retained" not in str(batch.state)


def test_omp_fork_copied_history_owned_by_parent(tmp_path):
    parent_path = tmp_path / "project" / "parent.jsonl"
    child_path = tmp_path / "project" / "parent" / "child.jsonl"
    inherited = omp_record()
    write(parent_path, [dict(type="session", id="parent", cwd="/project"), inherited])
    write(child_path, [dict(type="session", id="child", parentSession=str(parent_path),
                            cwd="/project"), inherited, omp_record("child-entry")])
    adapter = OmpAdapter(tmp_path)
    assert len(list(adapter.discover())) == 2
    parent = adapter.parse_file(str(parent_path))
    child = adapter.parse_file(str(child_path))
    assert len(parent.events) == len(child.events) == 1
    assert child.events[0].parent_session_id == "parent"
    assert child.events[0].agent_type == "subagent"
    assert parent.events[0].key != child.events[0].key


def test_omp_uuid_parent_and_missing_ancestor_keep_observed_calls(tmp_path):
    write(tmp_path / "project" / "parent.jsonl", [
        dict(type="session", id="parent"), omp_record()])
    child_path = write(tmp_path / "project" / "child.jsonl", [
        dict(type="session", id="child", parentSession="parent"), omp_record(), omp_record("new")])
    adapter = OmpAdapter(tmp_path)
    list(adapter.discover())
    assert len(adapter.parse_file(child_path).events) == 1
    (tmp_path / "project" / "parent.jsonl").unlink()
    adapter = OmpAdapter(tmp_path)
    list(adapter.discover())
    batch = adapter.parse_file(child_path)
    assert len(batch.events) == 2
    assert batch.events[0].parent_session_id == "parent"


def dsh_event(kind, seq, time=1791115200000, **data):
    if kind == "turn/end" and "reason" not in data:
        data["reason"] = {"kind": "completed"}
    return dict(type=kind, seq=seq, time=time, data=data)


def dsh_header(version=4, **extra):
    return dict(type="session", version=version, id="session", isSeeded=False,
                createdAt=1791115200000, cwd="/project", **extra)


def dsh_usage(output=4):
    return dict(inputTokens=10, cacheReadTokens=20, cacheWriteTokens=3,
                outputTokens=output, reasoningTokens=2, totalTokens=33 + output)


def test_dsh_v4_message_stream_is_one_call_and_failed_attempt_additive(tmp_path):
    rows = [dsh_header(), dsh_event("turn/start", 0, turn=1),
            dsh_event("request/context", 1, provider="route", model="model"),
            dsh_event("assistant/message", 2, time=1791115201000, turn=1, step=1,
                      usage=dsh_usage(), message=dict(source=dict(provider="route", model="model")),
                      stream=[dict(type="chunk", time=1791115201000,
                                   chunk=dict(type="usage", usage=dsh_usage()))]),
            dsh_event("assistant/attempt", 3, time=1791115201500, turn=1, step=2,
                      stream=[dict(type="chunk", time=1791115201500,
                                   chunk=dict(type="usage", usage=dsh_usage(2)))]),
            dsh_event("turn/end", 4, time=1791115202000, turn=1)]
    batch = DshAdapter(tmp_path).parse_file(write(tmp_path / "session.v4.jsonl", rows))
    assert len(batch.events) == 2
    assert sum(event.output for event in batch.events) == 6
    assert len(batch.timing_samples) == 1
    assert batch.timing_samples[0].output == 6
    assert batch.timing_samples[0].end_us - batch.timing_samples[0].start_us == 2000000


def test_dsh_seed_boundary_excludes_usage_preserves_route(tmp_path):
    info = dsh_header(parentSession="parent")
    info["isSeeded"] = True
    rows = [info, dsh_event("request/context", 0, provider="route", model="model"),
            dsh_event("assistant/message", 1, turn=1, step=1, usage=dsh_usage()),
            dsh_event("session/end-seed", 2, inherited=True),
            dsh_event("assistant/message", 3, turn=2, step=1, usage=dsh_usage())]
    batch = DshAdapter(tmp_path).parse_file(write(tmp_path / "session.v4.jsonl", rows))
    assert len(batch.events) == 1 and batch.events[0].model == "model"
    assert batch.events[0].parent_session_id == "parent"


def test_dsh_unknown_newest_generation_never_falls_back(tmp_path):
    directory = tmp_path / "sessions" / "project" / "session"
    write(directory / "session.v3.jsonl", [dsh_header(3)])
    write(directory / "session.v5.jsonl", [dsh_header(5)])
    adapter = DshAdapter(tmp_path)
    sources = list(adapter.discover())
    assert len(sources) == 1 and sources[0].path.endswith("session.v5.jsonl")
    batch = adapter.parse_file(sources[0].path)
    assert not batch.events and batch.warnings


def test_dsh_concat_zstd_frames_and_torn_append(tmp_path):
    compressor = zstandard.ZstdCompressor()
    prefix = (json.dumps(dsh_header()) + "\n").encode()
    middle = (json.dumps(dsh_event("assistant/message", 0, turn=1, step=1,
                                 usage=dsh_usage())) + "\n").encode()
    tail = (json.dumps(dsh_event("assistant/message", 1, turn=1, step=2,
                               usage=dsh_usage())) + "\n").encode()
    path = tmp_path / "session.v4.jsonl.zstd"
    complete = compressor.compress(prefix) + compressor.compress(middle)
    path.write_bytes(complete + compressor.compress(tail)[:-3])
    decoded, torn = decode_zstd(path)
    assert torn and decoded == prefix + middle
    batch = DshAdapter(tmp_path).parse_file(str(path))
    assert len(batch.events) == 1 and any("zstd frame" in warning for warning in batch.warnings)
    path.write_bytes(complete + compressor.compress(tail))
    batch = DshAdapter(tmp_path).parse_file(str(path))
    assert len(batch.events) == 2


def test_dsh_legacy_usage_chunk_message_and_retry(tmp_path):
    rows = [dsh_header(0),
            dsh_event("assistant/chunk", 0, turn=1, step=1,
                      chunk=dict(type="usage", usage=dsh_usage(2))),
            dsh_event("assistant/message", 1, turn=1, step=1, usage=dsh_usage(4)),
            dsh_event("llm/retry-started", 2, turn=1, step=1),
            dsh_event("assistant/message", 3, turn=1, step=1, usage=dsh_usage(3))]
    batch = DshAdapter(tmp_path).parse_file(write(tmp_path / "session.jsonl", rows))
    assert len(batch.events) == 2
    assert sum(event.output for event in batch.events) == 7


def test_dsh_missing_usage_has_warning_and_no_fake_zero(tmp_path):
    rows = [dsh_header(), dsh_event("turn/start", 0, turn=1),
            dsh_event("assistant/attempt", 1, turn=1, step=1, stream=[]),
            dsh_event("turn/end", 2, time=1791115202000, turn=1)]
    batch = DshAdapter(tmp_path).parse_file(write(tmp_path / "session.v4.jsonl", rows))
    assert not batch.events and not batch.timing_samples
    assert any("no recorded usage" in warning for warning in batch.warnings)


def test_dsh_multiple_settlements_same_step_are_distinct(tmp_path):
    rows = [dsh_header(),
            dsh_event("assistant/attempt", 0, turn=1, step=1,
                      stream=[dict(type="chunk", chunk=dict(type="usage", usage=dsh_usage()))]),
            dsh_event("assistant/message", 1, turn=1, step=1, usage=dsh_usage())]
    batch = DshAdapter(tmp_path).parse_file(write(tmp_path / "session.v4.jsonl", rows))
    assert len({event.key for event in batch.events}) == 2


def test_dsh_auxiliary_request_without_settlement_is_coverage_gap(tmp_path):
    rows = [dsh_header(), dsh_event("session/title-llm-request", 0, route={"model": "title"})]
    batch = DshAdapter(tmp_path).parse_file(write(tmp_path / "session.v4.jsonl", rows))
    assert not batch.events and any("no persisted usage" in warning for warning in batch.warnings)


def test_claude_local_synthetic_zero_excluded_real_model_zero_retained(tmp_path):
    synthetic = claude_response("synthetic", output=0)
    synthetic["isApiErrorMessage"] = False
    synthetic["message"]["model"] = "<synthetic>"
    for field in ["input_tokens", "output_tokens", "cache_read_input_tokens",
                  "cache_creation_input_tokens"]:
        synthetic["message"]["usage"][field] = 0
    real = json.loads(json.dumps(synthetic))
    real["message"]["model"] = "real-model"
    real["message"]["id"] = "real"
    batch = ClaudeAdapter(tmp_path).parse_file(write(tmp_path / "a.jsonl", [synthetic, real]))
    assert len(batch.events) == 1 and batch.events[0].model == "real-model"


def test_dsh_interrupted_turn_has_usage_without_complete_timing(tmp_path):
    rows = [dsh_header(), dsh_event("turn/start", 0, turn=1),
            dsh_event("assistant/message", 1, turn=1, step=1, usage=dsh_usage()),
            dsh_event("turn/end", 2, time=1791115202000, turn=1,
                      reason={"kind": "interrupted"})]
    batch = DshAdapter(tmp_path).parse_file(write(tmp_path / "session.v4.jsonl", rows))
    assert len(batch.events) == 1 and not batch.timing_samples
