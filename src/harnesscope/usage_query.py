"""Window-first request ledger, with aggregation before sorting and pagination."""
import bisect
import json
from collections import Counter, defaultdict
from datetime import datetime
from typing import Any

from .names import labelled
from .query import UTC, _iso, _summary

GROUPS = ('request', 'session', 'turn', 'model', 'harness', 'provider', 'account')
SORTS = ('time', 'cost_usd', 'tokens', 'input_net', 'cache_read', 'cache_write',
         'output', 'calls', 'response_tps', 'turn_tps')


def _key(event, group):
    if group == 'request':
        return event['harness'], event['key']
    if group == 'session':
        return event['harness'], event['session_id']
    if group == 'turn':
        return event['harness'], event['session_id'], event['turn_id']
    if group in ('provider', 'account'):
        return (str(event.get('account_ref' if group == 'account' else group) or ''),)
    return (event[group],)


def _timing_totals(samples):
    totals: dict[tuple[str, str], dict[str, Any]] = {}
    for sample in samples:
        identity = sample['harness'], sample['kind']
        value = totals.setdefault(identity, {'harness': identity[0], 'kind': identity[1],
                                           'samples': 0, 'output': 0, 'seconds': 0.0})
        value['samples'] += 1
        value['output'] += sample['output']
        value['seconds'] += (sample['end_us'] - sample['start_us']) / 1e6
    return [{**value, 'tps': value['output'] / value['seconds']} for _, value in sorted(totals.items())]


def _speed(timing, kind):
    values = [sample for sample in timing if sample['kind'] == kind]
    return values[0]['tps'] if len(values) == 1 else None


class UsageQuery:
    def __init__(self, query):
        self.query = query

    def usage(self, request, group='request', offset=0, limit=50, sort='time', order='desc', turn_ids=()):
        if group not in GROUPS or sort not in SORTS or order not in ('asc', 'desc'):
            raise ValueError('invalid usage group, sort or order')
        if offset < 0 or not 1 <= limit <= 200:
            raise ValueError('offset must be nonnegative and limit must be 1..200')
        query = self.query
        with query.index.read_snapshot() as conn:
            start, end = query._window(conn, request)
            events = query._events(conn, start, end, request.filters, turn_ids=turn_ids)
            grouped = defaultdict(list)
            by_event, by_turn = {}, defaultdict(list)
            for event in events:
                grouped[_key(event, group)].append(event)
                by_event[(event['harness'], event['key'])] = event
                identity = (event['harness'], event['session_id'], event['turn_id'], event['model'], event['provider'])
                by_turn[identity].append(event)
            stamps = {key: [event['timestamp_us'] for event in members] for key, members in by_turn.items()}
            _, samples = query._timing(conn, start, end, request.filters, with_samples=True)
            timings = defaultdict(list)
            admitted = []
            for sample in samples:
                if sample['kind'] == 'model':
                    event = by_event.get((sample['harness'], sample['key']))
                    members = [event] if event and event['output'] == sample['output'] else []
                else:
                    if group == 'request' or group == 'turn' and sample['turn_id'] is None:
                        continue
                    identity = (sample['harness'], sample['session_id'], sample['turn_id'], sample['model'], sample['provider'])
                    times = stamps.get(identity, [])
                    lo = bisect.bisect_left(times, sample['start_us'])
                    hi = bisect.bisect_right(times, sample['end_us'])
                    members = by_turn.get(identity, [])[lo:hi]
                    if sum(event['output'] for event in members) != sample['output']:
                        continue
                if not members:
                    continue
                identities = {_key(event, group) for event in members}
                if len(identities) != 1:
                    continue
                timings[next(iter(identities))].append(sample)
                admitted.append(sample)
            timing_values = {key: _timing_totals(values) for key, values in timings.items()}

            def amount(key):
                members = grouped[key]
                if sort == 'time':
                    return members[-1]['timestamp_us']
                if sort in ('response_tps', 'turn_tps'):
                    return _speed(timing_values.get(key, []), 'model' if sort == 'response_tps' else 'end_to_end')
                if sort == 'calls':
                    return len(members)
                if sort == 'cost_usd':
                    return sum(event['_cost'] or 0 for event in members) if any(event['_cost'] is not None for event in members) else None
                if sort == 'cache_write' and any(event['cache_write'] is None for event in members):
                    return None
                if sort == 'tokens':
                    return sum(event['input_net'] + event['cache_read'] + (event['cache_write'] or 0) + event['output'] for event in members)
                return sum(event[sort] for event in members)

            def sorting(key):
                value = amount(key)
                return (value is None, (-value if order == 'desc' else value) if value is not None else 0,
                        json.dumps(key, ensure_ascii=False, separators=(',', ':')))

            keys = sorted(grouped, key=sorting)
            rows = []
            for key in keys[offset:offset+limit]:
                members = grouped[key]
                first = members[0]
                row_identity = {'harness': first['harness'] if group in ('request', 'session', 'turn', 'harness') else None,
                            'session_id': first['session_id'] if group in ('request', 'session', 'turn') else None,
                            'turn_id': first['turn_id'] if group in ('request', 'turn') else None,
                            'model': first['model'] if group in ('request', 'model') else None,
                            'provider': first['provider'] if group in ('request', 'provider') else None,
                            'account_ref': first.get('account_ref') if group in ('request', 'account') else None,
                            'event_key': first['key'] if group == 'request' else None}
                timing = timing_values.get(key, [])
                rows.append({'key': json.dumps(key, ensure_ascii=False, separators=(',', ':')),
                             'identity': row_identity,
                             'first': _iso(datetime.fromtimestamp(first['timestamp_us']/1e6, UTC)),
                             'last': _iso(datetime.fromtimestamp(members[-1]['timestamp_us']/1e6, UTC)),
                             'projects': sorted({event['project'] for event in members if event['project']}),
                             'harnesses': sorted({event['harness'] for event in members}),
                             'models': sorted({event['model'] for event in members}),
                             'providers': sorted({str(event['provider'] or '') for event in members}),
                             'accounts': sorted({str(event.get('account_ref') or '') for event in members}),
                             'metrics': _summary(members), 'timing': timing,
                             'response_tps': _speed(timing, 'model'), 'turn_tps': _speed(timing, 'end_to_end')})
            summary = _summary(events, (end-start).total_seconds())
            summary['tps'] = _timing_totals(admitted)
            return labelled(conn, {'snapshot': query._snapshot(conn), 'query': {**query._query(request, start, end), 'turn_ids': list(turn_ids)},
                    'group': group, 'sort': sort, 'order': order, 'summary': summary,
                    'coverage': {'usage_quality': dict(Counter(event['quality'] for event in events)),
                                 'unassigned_calls': sum(event['turn_id'] is None for event in events),
                                 'priced_calls': summary['priced_calls'], 'unpriced_calls': summary['unpriced_calls'],
                                 'timing_scope': 'complete_attributable_samples'},
                    'facets': query._facets(conn, start, end, request.filters, turn_ids=turn_ids),
                    'rows': rows, 'total': len(keys), 'offset': offset, 'limit': limit})
