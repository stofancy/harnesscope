"""Synthetic source transcripts for browser acceptance; never reads personal logs.

Hand-counted default window: 00:00:00 <= time < 00:01:30 UTC.
800 tokens / 3 calls in its first 60 seconds; 500 / 3 in the last 30.
All four harnesses participate. Public-equivalent cost: $0.005085.
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

CODEX_SID = '11111111-1111-4111-8111-111111111111'
CODEX_NAME = f'rollout-2026-10-01T00-00-00-{CODEX_SID}.jsonl'
MODEL = 'e2e-known'
PROJECT = '/synthetic/workbench'


def stamp(seconds):
    return f'2026-10-01T00:{seconds // 60:02d}:{seconds % 60:02d}Z'


def line(record):
    return json.dumps(record, separators=(',', ':')) + '\n'


def write(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(line(record) for record in records))


def codex_event(seconds, kind, **payload):
    if kind == 'task_started':
        payload['started_at'] = 1790812800 + seconds  # Native Codex boundary is epoch seconds.
    elif kind == 'task_complete':
        payload['completed_at'] = 1790812800 + seconds
    return {'timestamp': stamp(seconds), 'type': 'event_msg', 'payload': {'type': kind, **payload}}


def codex_call(response, turn, seconds, gross, read, output):
    return {'timestamp': stamp(seconds), 'type': 'token_usage_record', 'payload': {
        'response_id': response, 'thread_id': CODEX_SID, 'session_id': CODEX_SID,
        'turn_id': turn, 'root_turn_id': turn,
        'usage': {'input_tokens': gross, 'cached_input_tokens': read,
                  'cache_write_input_tokens': 0, 'output_tokens': output,
                  'reasoning_output_tokens': 0, 'total_tokens': gross + output}}}


def codex_tool(seconds, call, name='exec_command'):
    return {'timestamp': stamp(seconds), 'type': 'response_item', 'payload': {
        'type': 'function_call', 'call_id': call, 'name': name, 'arguments': '{}'}}


def codex_tool_end(seconds, call, code):
    return {'timestamp': stamp(seconds), 'type': 'response_item', 'payload': {
        'type': 'function_call_output', 'call_id': call, 'is_error': code != 0,
        'output': f'Process exited with code {code}\nSynthetic fixture result'}}


def prepare(root):
    root = Path(root)
    for name in ('codex/sessions', 'codex/archived_sessions', 'claude/projects', 'omp', 'dsh/sessions', 'cache'):
        (root / name).mkdir(parents=True, exist_ok=True)
    codex = [
        {'timestamp': stamp(0), 'type': 'session_meta', 'payload': {
            'id': CODEX_SID, 'cwd': PROJECT, 'timestamp': stamp(0), 'thread_source': 'cli', 'model_provider': 'e2e'}},
        {'timestamp': stamp(0), 'type': 'turn_context', 'payload': {'model': MODEL, 'cwd': PROJECT}},
        codex_event(0, 'thread_settings_applied', thread_id=CODEX_SID,
                    thread_settings={'model': MODEL, 'service_tier': 'default', 'model_provider_id': 'e2e'}),
        codex_event(5, 'task_started', turn_id='codex-turn-1'),
        codex_call('response-codex-1', 'codex-turn-1', 10, 100, 20, 30),
        codex_tool(11, 'tool-ok'), codex_tool_end(12, 'tool-ok', 0),
        codex_tool(13, 'tool-error'), codex_tool_end(14, 'tool-error', 1),
        codex_call('response-codex-2', 'codex-turn-1', 20, 200, 40, 70),
        codex_event(25, 'task_complete', turn_id='codex-turn-1'),
        codex_event(80, 'task_started', turn_id='codex-turn-live'),
        codex_tool(82, 'tool-live'),
        codex_call('response-codex-live', 'codex-turn-live', 85, 50, 0, 50),
    ]
    write(root / 'codex/sessions/2026/10/01' / CODEX_NAME, codex)
    # A completed human turn; read tool result is a continuation of that turn.
    claude = [
        {'type': 'user', 'uuid': 'claude-user-1', 'sessionId': 'claude-session', 'timestamp': stamp(30),
         'cwd': PROJECT, 'message': {'role': 'user', 'content': 'Synthetic request'}},
        {'type': 'assistant', 'uuid': 'claude-assistant-1', 'parentUuid': 'claude-user-1',
         'sessionId': 'claude-session', 'timestamp': stamp(40), 'cwd': PROJECT,
         'requestId': 'request-claude-1', 'message': {'id': 'response-claude-1', 'role': 'assistant', 'model': MODEL,
             'stop_reason': 'tool_use', 'content': [{'type': 'tool_use', 'id': 'claude-tool-1', 'name': 'Read', 'input': {}}],
             'usage': {'input_tokens': 100, 'cache_read_input_tokens': 100,
                       'cache_creation_input_tokens': 100, 'output_tokens': 100}}},
        {'type': 'user', 'uuid': 'claude-result-1', 'parentUuid': 'claude-assistant-1',
         'sessionId': 'claude-session', 'timestamp': stamp(42), 'cwd': PROJECT,
         'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'claude-tool-1', 'is_error': False, 'content': 'Fixture'}]}},
        {'type': 'assistant', 'uuid': 'claude-final-1', 'parentUuid': 'claude-result-1',
         'sessionId': 'claude-session', 'timestamp': stamp(44), 'cwd': PROJECT,
         'requestId': 'request-claude-1', 'message': {'id': 'response-claude-1', 'role': 'assistant', 'model': MODEL,
             'stop_reason': 'end_turn', 'content': [],
             'usage': {'input_tokens': 100, 'cache_read_input_tokens': 100,
                       'cache_creation_input_tokens': 100, 'output_tokens': 100}}},
        # Separate late turn, missing model price and cache-write field.
        {'type': 'user', 'uuid': 'claude-user-unknown', 'sessionId': 'claude-session',
         'timestamp': stamp(95), 'cwd': PROJECT, 'message': {'role': 'user', 'content': 'Synthetic request'}},
        {'type': 'assistant', 'uuid': 'claude-unknown', 'parentUuid': 'claude-user-unknown',
         'sessionId': 'claude-session', 'timestamp': stamp(100), 'cwd': PROJECT,
         'requestId': 'request-unknown', 'message': {'id': 'response-unknown', 'role': 'assistant',
             'model': 'e2e-unpriced', 'stop_reason': 'end_turn', 'content': [],
             'usage': {'input_tokens': 20, 'output_tokens': 10}}},
    ]
    write(root / 'claude/projects/synthetic/claude-session.jsonl', claude)
    omp = [
        {'type': 'session', 'id': 'omp-session', 'cwd': PROJECT},
        {'type': 'message', 'id': 'omp-user-1', 'timestamp': stamp(55),
         'message': {'role': 'user', 'content': 'Synthetic request'}},
        {'type': 'message', 'id': 'omp-assistant-1', 'parentId': 'omp-user-1', 'timestamp': stamp(65),
         'message': {'role': 'assistant', 'model': MODEL, 'provider': 'e2e', 'responseId': 'response-omp-1',
             'timestamp': 1790812865000, 'completedAt': 1790812875000, 'duration': 10000,
             'content': [{'type': 'toolCall', 'id': 'omp-tool-1', 'name': 'bash', 'arguments': {}}],
             'usage': {'input': 50, 'output': 100, 'cacheRead': 50, 'cacheWrite': 0, 'totalTokens': 200}}},
        {'type': 'message', 'id': 'omp-tool-result', 'parentId': 'omp-assistant-1', 'timestamp': stamp(70),
         'message': {'role': 'toolResult', 'toolCallId': 'omp-tool-1', 'toolName': 'bash', 'isError': False, 'content': []}},
    ]
    write(root / 'omp/omp-session.jsonl', omp)
    dsh = [
        {'type': 'session', 'version': 4, 'id': 'dsh-session', 'cwd': PROJECT},
        {'type': 'request/header', 'seq': 0, 'time': 1790812800000, 'data': {'header': {'config': {'model': MODEL, 'provider': 'e2e'}}}},
        {'type': 'turn/start', 'seq': 1, 'time': 1790812875000, 'data': {'turn': 1}},
        {'type': 'assistant/message', 'seq': 2, 'time': 1790812880000, 'data': {'turn': 1, 'step': 0,
            'message': {'source': {'model': MODEL, 'provider': 'e2e'}},
            'usage': {'inputTokens': 100, 'outputTokens': 100, 'cacheReadTokens': 0, 'cacheWriteTokens': 0, 'totalTokens': 200}}},
        {'type': 'turn/end', 'seq': 3, 'time': 1790812885000, 'data': {'turn': 1, 'reason': {'kind': 'completed'}}},
    ]
    write(root / 'dsh/sessions/dsh-session/session.v4.jsonl', dsh)
    (root / 'pricing.json').write_text(json.dumps({MODEL: {'inputCostPerMillion': 2,
        'cacheReadCostPerMillion': .5, 'cacheWriteCostPerMillion': 3, 'outputCostPerMillion': 8}}))
    (root / 'codex/config.toml').write_text('service_tier = "default"\n')
    return root


def append_completion(root):
    """Replays one identity, adds one new call, then closes the existing turn/tool."""
    path = Path(root) / 'codex/sessions/2026/10/01' / CODEX_NAME
    with path.open('a') as stream:
        stream.write(line(codex_call('response-codex-live', 'codex-turn-live', 85, 50, 0, 50)))
        stream.write(line(codex_call('response-codex-live-extra', 'codex-turn-live', 86, 50, 0, 50)))
        stream.write(line(codex_tool_end(88, 'tool-live', 1)))
        stream.write(line(codex_event(89, 'task_complete', turn_id='codex-turn-live')))


def append_recent(root, ordinal):
    """A new 100-token call after the UI's saved relative-window cutoff."""
    now = datetime.now(timezone.utc)
    turn = f'codex-recent-{ordinal}'
    started = now - timedelta(seconds=1)
    records = [
        {'timestamp': started.isoformat(), 'type': 'event_msg', 'payload': {
            'type': 'task_started', 'turn_id': turn, 'started_at': started.timestamp()}},
        codex_call(f'response-recent-{ordinal}', turn, 85, 50, 0, 50),
        {'timestamp': now.isoformat(), 'type': 'event_msg', 'payload': {
            'type': 'task_complete', 'turn_id': turn, 'completed_at': now.timestamp()}},
    ]
    records[1]['timestamp'] = now.isoformat()
    with (Path(root) / 'codex/sessions/2026/10/01' / CODEX_NAME).open('a') as stream:
        stream.writelines(line(record) for record in records)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--append', type=Path, required=True)
    parser.add_argument('--recent-call', type=int)
    args = parser.parse_args()
    if not args.append.name.startswith('codex-usage-browser-'):
        parser.error('append target must be the dedicated temporary browser fixture')
    if args.recent_call is None:
        append_completion(args.append)
    else:
        append_recent(args.append, args.recent_call)
