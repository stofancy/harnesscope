"""Synthetic source transcripts for browser acceptance; never reads personal logs.

Hand-counted default window: 00:00:00 <= time < 00:01:30 UTC.
800 tokens / 3 calls in its first 60 seconds; 500 / 3 in the last 30.
All four harnesses participate. Public-equivalent cost: $0.005085.
"""
import json
import sqlite3
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
    # Reasoning is a subset of output; the 1300-token ledger is unchanged.
    codex[4]['payload']['usage']['reasoning_output_tokens'] = 10
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
    write(root / 'dsh/sessions/warning-session/session.v4.jsonl', [
        {'type': 'session', 'version': 4, 'id': 'warning-session', 'cwd': PROJECT},
        {'type': 'session/title-llm-request', 'seq': 0, 'time': 1790726400000, 'data': {}},
        {'type': 'web/deepseek-search-llm-request', 'seq': 1, 'time': 1790726401000, 'data': {}},
        {'type': 'assistant/attempt', 'seq': 2, 'time': 1790726402000,
         'data': {'turn': 1, 'step': 0, 'message': {'source': {'model': MODEL}}, 'stream': []}},
    ])
    (root / 'pricing.json').write_text(json.dumps({MODEL: {'inputCostPerMillion': 2,
        'cacheReadCostPerMillion': .5, 'cacheWriteCostPerMillion': 3, 'outputCostPerMillion': 8}}))
    prepare_daily_cases(root)
    prepare_activity_cases(root)
    prepare_names(root)
    prepare_calendar_cases(root)
    (root / 'codex/config.toml').write_text('service_tier = "default"\n')
    return root


def prepare_names(root):
    """Native titles contain no prompt-derived or personal content."""
    with sqlite3.connect(root / 'codex/state_5.sqlite') as conn:
        conn.execute('CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT)')
        conn.executemany('INSERT INTO threads VALUES (?,?)', [
            (CODEX_SID, '费用看板联动'),
            ('44444444-1111-4111-8111-111111111111', '历史会话继续工作'),
            ('66666666-6666-4666-8666-666666666666', '主目录费用复核'),
            ('77777777-7777-4777-8777-777777777777', '工作树速率复核'),
        ])
    with (root / 'claude/projects/synthetic/claude-session.jsonl').open('a') as stream:
        stream.write(line({'type': 'ai-title', 'sessionId': 'claude-session', 'aiTitle': '自动缓存分析'}))
        stream.write(line({'type': 'custom-title', 'sessionId': 'claude-session', 'customTitle': '缓存报表核对'}))
    path = root / 'omp/omp-session.jsonl'
    records = [json.loads(v) for v in path.read_text().splitlines()]
    records[0]['title'] = '响应速度分析'
    write(path, records)
    with (root / 'dsh/sessions/dsh-session/session.v4.jsonl').open('a') as stream:
        stream.write(line({'type': 'session/title', 'seq': 4, 'time': 1790812890000,
                           'data': {'title': '工具耗时整理'}}))
    day = '2026-09-29T00:00:00Z'
    for sid, project, gross in [
        ('66666666-6666-4666-8666-666666666666', '/synthetic/main/reporting', 20),
        ('77777777-7777-4777-8777-777777777777', '/synthetic/.codex/worktrees/ab12/reporting', 30),
    ]:
        call = codex_call(f'name-response-{gross}', None, 10, gross, 0, 10)
        call['timestamp'] = '2026-09-29T00:00:10Z'
        call['payload'].update(thread_id=sid, session_id=sid)
        write(root / 'codex/sessions/2026/09/29' / f'rollout-2026-09-29T00-00-00-{sid}.jsonl', [
            {'timestamp': day, 'type': 'session_meta', 'payload': {'id': sid, 'cwd': project, 'timestamp': day}},
            {'timestamp': day, 'type': 'turn_context', 'payload': {'model': MODEL, 'cwd': project}},
            call,
        ])
    write(root / 'claude/projects/synthetic/shared-session.jsonl', [
        {'type': 'custom-title', 'sessionId': '66666666-6666-4666-8666-666666666666',
         'customTitle': 'Claude 共享身份名称'},
        {'type': 'user', 'uuid': 'names-user', 'sessionId': '66666666-6666-4666-8666-666666666666',
         'timestamp': day, 'cwd': '/synthetic/main/reporting',
         'message': {'role': 'user', 'content': 'Synthetic request'}},
        {'type': 'assistant', 'uuid': 'names-assistant', 'parentUuid': 'names-user',
         'sessionId': '66666666-6666-4666-8666-666666666666', 'timestamp': '2026-09-29T00:00:10Z',
         'cwd': '/synthetic/main/reporting', 'requestId': 'names-claude-request',
         'message': {'id': 'names-claude-response', 'role': 'assistant', 'model': MODEL,
             'stop_reason': 'end_turn', 'content': [], 'usage': {'input_tokens': 8,
                 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0, 'output_tokens': 2}}},
    ])


def rename_sessions(root):
    """Update only the disposable native names; usage totals remain unchanged."""
    root = Path(root)
    with sqlite3.connect(root / 'codex/state_5.sqlite') as conn:
        conn.execute('UPDATE threads SET title=? WHERE id=?', ('费用看板新名称', CODEX_SID))
    with (root / 'claude/projects/synthetic/claude-session.jsonl').open('a') as stream:
        stream.write(line({'type': 'custom-title', 'sessionId': 'claude-session', 'customTitle': '缓存报表新名称'}))
    omp_path = root / 'omp/omp-session.jsonl'
    records = [json.loads(v) for v in omp_path.read_text().splitlines()]
    records[0]['title'] = '响应速度新名称'
    write(omp_path, records)
    with (root / 'dsh/sessions/dsh-session/session.v4.jsonl').open('a') as stream:
        stream.write(line({'type': 'session/title', 'seq': 5, 'time': 1790812920000,
                           'data': {'title': '工具耗时新名称'}}))


def prepare_daily_cases(root):
    """Independent days keep the original four-source ledger unchanged."""
    base = datetime(2026, 10, 2, tzinfo=timezone.utc)
    session = '22222222-2222-4222-8222-222222222222'
    records = [
        {'timestamp': base.isoformat(), 'type': 'session_meta', 'payload': {
            'id': session, 'cwd': '/synthetic/ranking', 'timestamp': base.isoformat(), 'model_provider': 'e2e'}},
        {'timestamp': base.isoformat(), 'type': 'turn_context', 'payload': {'model': MODEL, 'cwd': '/synthetic/ranking'}},
    ]
    for index in range(25):
        turn = f'ranking-turn-{index:02d}'
        start = base + timedelta(seconds=index * 120)
        duration = 90 if index == 1 else 2 if index == 0 else 1
        end = start + timedelta(seconds=duration)
        output = 2000 if index == 0 else 10 if index == 1 else 10 + index
        call = codex_call(f'ranking-response-{index}', turn, 10, 0, 0, output)
        call['timestamp'] = end.isoformat()
        call['payload']['thread_id'] = session
        call['payload']['session_id'] = session
        records.extend([
            {'timestamp': start.isoformat(), 'type': 'event_msg', 'payload': {
                'type': 'task_started', 'turn_id': turn, 'started_at': start.timestamp()}},
            call,
            {'timestamp': end.isoformat(), 'type': 'event_msg', 'payload': {
                'type': 'task_complete', 'turn_id': turn, 'completed_at': end.timestamp()}},
        ])
    write(root / 'codex/sessions/2026/10/02' / f'rollout-2026-10-02T00-00-00-{session}.jsonl', records)

    partial = []
    for index, (model, usage) in enumerate([
        (MODEL, {'input_tokens': 50, 'cache_read_input_tokens': 0,
                 'cache_creation_input_tokens': 0, 'output_tokens': 50}),
        ('e2e-unpriced', {'input_tokens': 20, 'output_tokens': 10}),
    ]):
        start = datetime(2026, 10, 3, 0, 0, index * 10, tzinfo=timezone.utc)
        user = f'partial-user-{index}'
        partial.extend([
            {'type': 'user', 'uuid': user, 'sessionId': 'partial-session',
             'timestamp': start.isoformat(), 'cwd': PROJECT,
             'message': {'role': 'user', 'content': 'Synthetic partial request'}},
            {'type': 'assistant', 'uuid': f'partial-assistant-{index}', 'parentUuid': user,
             'sessionId': 'partial-session', 'timestamp': (start + timedelta(seconds=2)).isoformat(),
             'cwd': PROJECT, 'requestId': f'partial-request-{index}',
             'message': {'id': f'partial-response-{index}', 'role': 'assistant',
                         'model': model, 'stop_reason': 'end_turn', 'content': [], 'usage': usage}},
        ])
    write(root / 'claude/projects/synthetic/partial-session.jsonl', partial)


def prepare_activity_cases(root):
    """Old open metadata is separate from real window activity and orphan usage."""
    project = '/synthetic/company/platform/products/usage-workbench/feature-branches/extremely-long-project-path/activity'
    old = datetime(2026, 9, 30, tzinfo=timezone.utc)
    recent = datetime(2026, 10, 4, tzinfo=timezone.utc)
    for sid, active in [
        ('44444444-1111-4111-8111-111111111111', True),
        ('55555555-5555-4555-8555-555555555555', False),
    ]:
        turn = 'old-active-turn' if active else 'old-stale-turn'
        records = [
            {'timestamp': old.isoformat(), 'type': 'session_meta', 'payload': {
                'id': sid, 'cwd': project, 'timestamp': old.isoformat(), 'model_provider': 'e2e'}},
            {'timestamp': old.isoformat(), 'type': 'turn_context', 'payload': {'model': MODEL, 'cwd': project}},
            {'timestamp': old.isoformat(), 'type': 'event_msg', 'payload': {
                'type': 'task_started', 'turn_id': turn, 'started_at': old.timestamp()}},
            codex_call(f'old-response-{sid}', turn, 0, 10, 0, 10),
            codex_tool(1, f'old-tool-{sid}'),
        ]
        records[3]['timestamp'] = old.isoformat()
        records[3]['payload'].update(thread_id=sid, session_id=sid)
        records[4]['timestamp'] = (old + timedelta(seconds=1)).isoformat()
        if active:
            call = codex_call('fresh-old-session', turn, 10, 100, 20, 30)
            call['timestamp'] = (recent + timedelta(seconds=10)).isoformat()
            call['payload'].update(thread_id=sid, session_id=sid)
            tool = codex_tool(11, 'fresh-tool', 'fresh_tool')
            tool['timestamp'] = (recent + timedelta(seconds=11)).isoformat()
            result = codex_tool_end(12, 'fresh-tool', 0)
            result['timestamp'] = (recent + timedelta(seconds=12)).isoformat()
            records.extend([call, tool, result])
        write(root / 'codex/sessions/2026/09/30' / f'rollout-2026-09-30T00-00-00-{sid}.jsonl', records)
    sid = '44444444-2222-4222-8222-222222222222'
    call = codex_call('unassigned-window-response', None, 20, 120, 30, 50)
    call['timestamp'] = (recent + timedelta(seconds=20)).isoformat()
    call['payload'].update(thread_id=sid, session_id=sid)
    call['payload'].pop('turn_id')
    call['payload'].pop('root_turn_id')
    call['payload']['usage']['cache_write_input_tokens'] = 20
    write(root / 'codex/sessions/2026/09/30' / f'rollout-2026-09-30T00-00-00-{sid}.jsonl', [
        {'timestamp': old.isoformat(), 'type': 'session_meta', 'payload': {
            'id': sid, 'cwd': project, 'timestamp': old.isoformat(), 'model_provider': 'e2e'}},
        {'timestamp': old.isoformat(), 'type': 'turn_context', 'payload': {'model': MODEL, 'cwd': project}},
        call,
    ])


def prepare_calendar_cases(root):
    """Independent local-year days; none overlap the fixed October ledger."""
    year = datetime.now().astimezone().year
    project = '/synthetic/calendar'
    for point_year, points in [
        (year - 1, [('12-31', 40, 10, 0, 50)]),
        (year, [('01-01', 80, 20, 10, 40), ('01-02', 50, 30, 20, 100),
                ('01-04', 20, 0, 0, 30)]),
    ]:
        sid = f'88888888-{point_year}-4888-8888-88888888{point_year}'
        header = datetime(point_year, 1, 1).astimezone(timezone.utc).isoformat()
        records = [
            {'timestamp': header, 'type': 'session_meta', 'payload': {
                'id': sid, 'cwd': project, 'timestamp': header, 'model_provider': 'e2e'}},
            {'timestamp': header, 'type': 'turn_context', 'payload': {'model': MODEL, 'cwd': project}},
        ]
        for index, (day, net, read, cache_write, output) in enumerate(points):
            at = datetime.fromisoformat(f'{point_year}-{day}T12:00:00').astimezone(timezone.utc)
            turn = f'calendar-turn-{point_year}-{day}'
            call = codex_call(f'calendar-response-{point_year}-{day}', turn, 10,
                              net + read + cache_write, read, output)
            call['timestamp'] = at.isoformat()
            call['payload'].update(thread_id=sid, session_id=sid)
            call['payload']['usage'].update(cache_write_input_tokens=cache_write,
                                           reasoning_output_tokens=10)
            records.extend([
                {'timestamp': (at - timedelta(seconds=2)).isoformat(), 'type': 'event_msg',
                 'payload': {'type': 'task_started', 'turn_id': turn,
                             'started_at': (at - timedelta(seconds=2)).timestamp()}},
                call,
                {'timestamp': (at + timedelta(seconds=1)).isoformat(), 'type': 'event_msg',
                 'payload': {'type': 'task_complete', 'turn_id': turn,
                             'completed_at': (at + timedelta(seconds=1)).timestamp()}},
            ])
        write(root / f'codex/sessions/{point_year}/01/01/rollout-calendar-{sid}.jsonl', records)
    records = []
    for day in ['01-03', '01-04']:
        at = datetime.fromisoformat(f'{year}-{day}T13:00:00').astimezone(timezone.utc)
        ident = f'calendar-unknown-{year}-{day}'
        records.extend([
            {'type': 'user', 'uuid': f'{ident}-user', 'sessionId': 'calendar-unknown',
             'timestamp': (at - timedelta(seconds=2)).isoformat(), 'cwd': project,
             'message': {'role': 'user', 'content': 'Synthetic calendar request'}},
            {'type': 'assistant', 'uuid': f'{ident}-assistant', 'parentUuid': f'{ident}-user',
             'sessionId': 'calendar-unknown', 'timestamp': at.isoformat(), 'cwd': project,
             'requestId': ident, 'message': {'id': ident, 'role': 'assistant',
                 'model': 'e2e-unpriced', 'stop_reason': 'end_turn', 'content': [],
                 'usage': {'input_tokens': 20, 'cache_read_input_tokens': 0, 'output_tokens': 10}}},
        ])
    write(root / 'claude/projects/synthetic/calendar-unknown.jsonl', records)


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
    parser.add_argument('--rename-sessions', action='store_true')
    args = parser.parse_args()
    if not args.append.name.startswith('harnesscope-browser-'):
        parser.error('append target must be the dedicated temporary browser fixture')
    if args.rename_sessions:
        rename_sessions(args.append)
    elif args.recent_call is None:
        append_completion(args.append)
    else:
        append_recent(args.append, args.recent_call)
