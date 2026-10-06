"""Generation throughput from recorded output boundaries; synthetic logs only."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from harnesscope import cli, stats
from harnesscope.parser import Session, collect, parse_codex_file, parse_rollout, to_local
from harnesscope.render import tables

SID = '00000000-0000-0000-0000-000000000001'
BASE = datetime(2026, 9, 30, tzinfo=timezone.utc)


def event(second, kind, payload):
    return json.dumps({'timestamp': (BASE + timedelta(seconds=second)).isoformat(),
                       'type': kind, 'payload': payload})


def output_item(turn_id, start, end, kind='AgentMessage'):
    return event(end, 'event_msg', {
        'type': 'item_completed', 'thread_id': SID, 'turn_id': str(turn_id),
        'started_at_ms': (BASE.timestamp() + start) * 1000,
        'completed_at_ms': (BASE.timestamp() + end) * 1000, 'item': {'type': kind}})


def turn(start=0, output=100, seconds=10, model='m', complete=True, timed=True):
    return [
        event(start, 'event_msg', {'type': 'task_started', 'turn_id': str(start)}),
        event(start, 'turn_context', {'model': model, 'turn_id': str(start)}),
        *([output_item(start, start + 2, start + 2 + seconds)] if timed else []),
        event(start + seconds + 3, 'event_msg', {
            'type': 'token_count', 'info': {'last_token_usage': {
                'input_tokens': 1000, 'output_tokens': output}}}),
        *([event(start + seconds + 30, 'event_msg', {
            'type': 'task_complete', 'turn_id': str(start)})] if complete else []),
    ]


def write(tmp_path, lines, suffix=''):
    path = tmp_path / f'rollout-2026-09-30T00-00-00-{SID}{suffix}.jsonl'
    path.write_text('\n'.join(lines) + '\n')
    return str(path)


def test_weighted_tps_and_untimed_output(tmp_path):
    rec = parse_rollout(write(tmp_path, turn() + turn(50, 900, 30)
                              + turn(120, 5000, complete=False, timed=False)))
    assert stats.rec_tokens(rec)[2] == 6000
    assert stats.rec_timing(rec) == (1000, 40)
    assert stats.rec_tps(rec) == 25  # An arithmetic mean of response rates is different.
    agg = stats.aggregate_models([rec], {})['m']
    assert stats.tps(*agg[7:9]) == 25


@pytest.mark.parametrize('start,end', [(3, 50)])
def test_window_clipping_keeps_tokens_but_excludes_partial_timing(tmp_path, start, end):
    rec = parse_rollout(write(tmp_path, turn(seconds=8)),
                        (to_local(BASE + timedelta(seconds=start)),
                         to_local(BASE + timedelta(seconds=end))))
    assert stats.rec_tokens(rec)[2] == 100
    assert stats.rec_tps(rec) is None


def test_window_excludes_later_usage(tmp_path):
    assert parse_rollout(write(tmp_path, turn()), (to_local(BASE),
                         to_local(BASE + timedelta(seconds=11)))) is None


def test_window_can_exclude_ttft_and_turn_completion(tmp_path):
    rec = parse_rollout(write(tmp_path, turn()), (to_local(BASE + timedelta(seconds=2)),
                                                 to_local(BASE + timedelta(seconds=14))))
    assert stats.rec_tps(rec) == 10


def test_duplicate_snapshot_does_not_inflate_tps(tmp_path):
    lines = turn()
    info = {'last_token_usage': {'input_tokens': 1000, 'output_tokens': 100},
            'total_token_usage': {'input_tokens': 1000, 'output_tokens': 100}}
    lines[3] = event(13, 'event_msg', {'type': 'token_count', 'info': info})
    lines.insert(4, event(14, 'event_msg', {'type': 'token_count', 'info': info}))
    rec = parse_rollout(write(tmp_path, lines))
    assert stats.rec_tps(rec) == 10


def test_multimodel_turn_attributes_each_response(tmp_path):
    lines = turn(complete=False)
    lines += [event(20, 'turn_context', {'model': 'other'}), output_item('0', 22, 32),
              event(33, 'event_msg', {'type': 'token_count', 'info': {
                  'last_token_usage': {'input_tokens': 1000, 'output_tokens': 300}}})]
    rec = parse_rollout(write(tmp_path, lines))
    assert stats.rec_tps(rec) == 20
    assert stats.rec_tps(rec, 'other') == 30
    stats.apply_filters([rec], model='other')
    assert stats.rec_tps(rec) == 30


def test_completed_response_in_active_turn_has_tps(tmp_path):
    rec = parse_rollout(write(tmp_path, turn(complete=False)))
    assert stats.rec_tps(rec) == 10


def test_pagination_merges_timing(tmp_path):
    write(tmp_path, turn())
    write(tmp_path, turn(50, 200, 10), '_00000000-0000-0000-0000-000000000002')
    recs = collect(str(tmp_path), to_local(BASE), to_local(BASE + timedelta(days=1)))
    assert len(recs) == 1
    assert stats.rec_tps(recs[0]) == 15


@pytest.mark.parametrize('view', ['flat', 'models', 'day', 'day_model', 'family', 'family_model'])
def test_views_and_json_use_same_weighted_tps(tmp_path, capsys, view):
    rec = parse_rollout(write(tmp_path, turn()))
    unknown = Session(file='f', sid='unknown', uuids=[], models={'m': [1000, 0, 900, 0, 1]})
    recs = [rec, unknown]
    if view == 'flat':
        tables.view_flat(recs, {})
    elif view == 'models':
        tables.view_models(recs, {})
    elif view.startswith('day'):
        tables.view_by_day(recs, {}, view == 'day_model')
    else:
        tables.view_families(recs, {}, view == 'family_model', False)
    output = capsys.readouterr().out
    assert 'TPS' in output and '10.0' in output
    cli._emit_json(recs, {})
    rows = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert rows[0]['tps'] == rows[0]['models']['m']['tps'] == 10
    assert rows[1]['tps'] is None


@pytest.mark.parametrize('change', ['wrong_owner', 'wrong_turn', 'zero_duration', 'missing_start', 'unrecorded_reasoning'])
def test_unreliable_first_output_is_unknown(tmp_path, change):
    lines = turn()
    item = json.loads(lines[2])
    if change == 'wrong_owner':
        item['payload']['thread_id'] = 'other'
    elif change == 'wrong_turn':
        item['payload']['turn_id'] = 'other'
    elif change == 'zero_duration':
        item['payload']['completed_at_ms'] = item['payload']['started_at_ms']
    elif change == 'missing_start':
        del item['payload']['started_at_ms']
    else:
        usage = json.loads(lines[3])
        usage['payload']['info']['last_token_usage']['reasoning_output_tokens'] = 50
        lines[3] = json.dumps(usage)
    lines[2] = json.dumps(item)
    rec = parse_rollout(write(tmp_path, lines))
    assert stats.rec_tokens(rec)[2] == 100
    assert stats.rec_tps(rec) is None


def native_usage(second, response='r1', output=100, reasoning=50):
    return event(second, 'token_usage_record', {
        'response_id': response, 'thread_id': SID, 'turn_id': 't',
        'usage': {'input_tokens': 1000, 'output_tokens': output,
                  'reasoning_output_tokens': reasoning}})


def test_native_response_excludes_tool_execution_and_survives_refresh(tmp_path):
    lines = [event(0, 'turn_context', {'model': 'm', 'turn_id': 't'}),
             event(0, 'event_msg', {'type': 'task_started', 'turn_id': 't'}),
             output_item('t', 2, 4, 'Reasoning'),
             output_item('t', 4, 6)]
    path = write(tmp_path, lines)
    first = parse_codex_file(path)
    assert not first.timing_samples
    appended = [event(60, 'response_item', {'type': 'function_call_output', 'call_id': 'c', 'output': 'result'}),
                native_usage(61),
                event(61, 'event_msg', {'type': 'token_count', 'info': {'last_token_usage': {
                    'input_tokens': 1000, 'output_tokens': 100, 'reasoning_output_tokens': 50}}})]
    with open(path, 'a') as f:
        f.write('\n'.join(appended) + '\n')
    second = parse_codex_file(path, first.next_offset, json.loads(json.dumps(first.state)))
    sample, = second.timing_samples
    assert (sample.key, sample.kind, sample.output) == ('response:r1', 'generation', 100)
    assert (sample.end_us - sample.start_us) / 1e6 == 4
    assert len(second.events) == 1
    assert stats.rec_tps(parse_rollout(path)) == 25
    with open(path, 'a') as f:
        f.write('\n'.join([native_usage(61), output_item('t', 2, 4, 'Reasoning'),
                           output_item('t', 65, 70), native_usage(71, 'r2', reasoning=0)]) + '\n')
    third = parse_codex_file(path, second.next_offset, second.state)
    assert len(third.events) == 1
    later, = third.timing_samples
    assert later.key == 'response:r2'
    assert (later.end_us - later.start_us) / 1e6 == 5
    all_samples = parse_codex_file(path).timing_samples
    assert all_samples == second.timing_samples + third.timing_samples


def test_tool_only_first_output_remains_unknown(tmp_path):
    path = write(tmp_path, [event(0, 'turn_context', {'model': 'm', 'turn_id': 't'}),
                 event(2, 'response_item', {'type': 'function_call', 'call_id': 'c'}),
                 output_item('t', 3, 4), native_usage(5, reasoning=0)])
    assert not parse_codex_file(path).timing_samples


def test_text_span_cannot_time_unrecorded_tool_argument_generation(tmp_path):
    path = write(tmp_path, [event(0, 'turn_context', {'model': 'm', 'turn_id': 't'}),
                 output_item('t', 2, 3, 'Reasoning'),
                 event(4, 'response_item', {'type': 'function_call', 'call_id': 'c'}),
                 native_usage(5)])
    assert not parse_codex_file(path).timing_samples


def test_complete_turn_without_first_output_does_not_supply_tps(tmp_path):
    assert stats.rec_tps(parse_rollout(write(tmp_path, turn(timed=False)))) is None
