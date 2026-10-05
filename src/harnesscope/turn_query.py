"""Turn and tool views sharing the analytics snapshot and pricing calculator."""
from collections import Counter, defaultdict
from datetime import datetime
import bisect

from .names import labelled
from .query import (UTC, COLUMN, QueryRequest, _us, _iso, _summary,
                    _bucket_edges, _bucket_seconds)

DIRECT_FILTERS = {'harness': 'harness', 'session': 'session_id', 'project': 'project', 'agent_type': 'agent_type'}
CALL_FILTERS = {'model', 'provider', 'purpose', 'service_tier', 'account'}
TURN_SORTS = ('start', 'cost_usd', 'tokens', 'duration', 'calls', 'tool_calls')


def _sort_turns(rows, sort, order):
    def value(row):
        if sort == 'start':
            return row['start_us']
        if sort == 'duration':
            return row['duration_seconds']
        if sort == 'tool_calls':
            return row['tool_calls_known']
        metrics = row['window_metrics']
        if sort == 'cost_usd' and not metrics['priced_calls']:
            return None
        return metrics[sort]
    def key(row):
        amount = value(row)
        return (amount is None, (-amount if order == 'desc' else amount) if amount is not None else 0,
                row['harness'], row['session_id'], row['turn_id'], row['key'])
    return sorted(rows, key=key)


def _identity(row):
    return row['harness'], row['session_id'], row['turn_id']


def _quantile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def _duration(row):
    if row['end_us'] is None or row['end_us'] < row['start_us']:
        return None
    return (row['end_us'] - row['start_us']) / 1e6


def _scope(filters):
    return 'filtered_calls' if CALL_FILTERS.intersection(filters) else 'all_recorded_calls'


def _matches(row, filters, direct_only=False):
    columns = DIRECT_FILTERS if direct_only else COLUMN
    return all(str(row.get(columns[dim]) or '') in values for dim, values in filters.items() if dim in columns)


def _public_event(event, start_us, end_us):
    return {**{key: value for key, value in event.items() if not key.startswith('_')},
            'cost_usd': event['_cost'], 'cost_detail': event['_cost_detail'],
            'in_window': start_us <= event['timestamp_us'] < end_us}


def _public_tool(tool, start_us, end_us):
    return {**tool, 'start': _iso(datetime.fromtimestamp(tool['start_us']/1e6, UTC)),
            'end': _iso(datetime.fromtimestamp(tool['end_us']/1e6, UTC)) if tool['end_us'] is not None else None,
            'duration_seconds': _duration(tool),
            'in_window': _boundary_in_window(tool, start_us, end_us)}


def _boundary_in_window(record, start_us, end_us):
    return (start_us <= record['start_us'] < end_us or
            record['end_us'] is not None and start_us <= record['end_us'] < end_us)


class TurnQuery:
    def __init__(self, query):
        self.query = query

    def _load(self, conn, request, start, end):
        start_us, end_us = _us(start), _us(end)
        active = '''WITH active AS (
            SELECT harness,session_id,turn_id FROM turns
                WHERE (start_us>=? AND start_us<?) OR (end_us>=? AND end_us<?)
            UNION SELECT harness,session_id,turn_id FROM events
                WHERE timestamp_us>=? AND timestamp_us<? AND turn_id IS NOT NULL
            UNION SELECT harness,session_id,turn_id FROM tool_calls
                WHERE (start_us>=? AND start_us<?) OR (end_us>=? AND end_us<?))'''
        clauses = []
        args = [start_us, end_us] * 5
        for dimension, values in request.filters.items():
            if dimension in DIRECT_FILTERS:
                clauses.append(f"COALESCE(t.{DIRECT_FILTERS[dimension]},'') IN ({','.join('?' for _ in values)})")
                args.extend(values)
        condition = ' AND '.join(clauses) or '1'
        turns = [dict(row) for row in conn.execute(f'''{active} SELECT t.* FROM turns t
            JOIN active a ON a.harness=t.harness AND a.session_id=t.session_id AND a.turn_id=t.turn_id
            WHERE {condition} ORDER BY t.start_us DESC,t.harness,t.session_id,t.turn_id''', args)]
        events = self.query._events(conn, start, end, request.filters)
        events_by_turn = defaultdict(list)
        for event in events:
            if event.get('turn_id') is not None:
                events_by_turn[_identity(event)].append(event)
        if CALL_FILTERS.intersection(request.filters):
            turns = [turn for turn in turns if _identity(turn) in events_by_turn]
        selected = {_identity(turn) for turn in turns}
        tools = [dict(row) for row in conn.execute('''SELECT c.* FROM tool_calls c
                JOIN turns t ON t.harness=c.harness AND t.session_id=c.session_id AND t.turn_id=c.turn_id
                WHERE (c.start_us>=? AND c.start_us<?) OR (c.end_us>=? AND c.end_us<?)
                ORDER BY c.start_us,c.key''',
                (start_us, end_us, start_us, end_us)) if _identity(row) in selected]
        tools_by_turn = defaultdict(list)
        for tool in tools:
            tools_by_turn[_identity(tool)].append(tool)
        rows = []
        for turn in turns:
            identity = _identity(turn)
            calls = events_by_turn[identity]
            full = turn['end_us'] is not None and start_us <= turn['start_us'] <= turn['end_us'] <= end_us
            recorded_available = full and bool(calls)
            duration = _duration(turn)
            metrics = _summary(calls, _bucket_seconds(start, end,
                datetime.fromtimestamp(turn['start_us']/1e6, UTC),
                datetime.fromtimestamp(turn['end_us']/1e6, UTC) if turn['end_us'] is not None else end))
            known_tools = len(tools_by_turn[identity])
            activity = [record['timestamp_us'] for record in calls]
            for record in [turn, *tools_by_turn[identity]]:
                activity.extend(value for value in (record['start_us'], record['end_us'])
                                if value is not None and start_us <= value < end_us)
            if not activity:
                continue
            rows.append({**turn, 'start': _iso(datetime.fromtimestamp(turn['start_us']/1e6, UTC)),
                         'end': _iso(datetime.fromtimestamp(turn['end_us']/1e6, UTC)) if turn['end_us'] is not None else None,
                         'duration_seconds': duration, 'full_window': full, 'recorded_usage_available': recorded_available,
                         'activity_us': min(activity),
                         'usage_scope': _scope(request.filters), 'tool_scope': 'selected_turns',
                         'window_metrics': metrics, 'full_metrics': metrics if recorded_available else None,
                         'tool_calls_known': known_tools,
                         'tool_calls': known_tools if turn['tool_coverage'] == 'complete' else None})
        selected = {_identity(row) for row in rows}
        selected_events = [event for event in events if _identity(event) in selected]
        return rows, selected_events, tools, len(events) - len(selected_events)

    @staticmethod
    def _summary(rows, events, tools, seconds):
        recorded = [row for row in rows if row['recorded_usage_available']]
        timed = [row for row in rows if row['full_window'] and row['duration_seconds'] is not None]
        durations = [row['duration_seconds'] for row in timed]
        complete_tools = bool(rows) and all(row['tool_coverage'] == 'complete' for row in rows)
        per_turn = {'samples': len(recorded), 'scope': 'recorded_usage',
                    'boundary_quality': dict(Counter(row['boundary_quality'] for row in recorded)),
                    'calls': sum(row['full_metrics']['calls'] for row in recorded) / len(recorded) if recorded else None,
                    'tokens': sum(row['full_metrics']['tokens'] for row in recorded) / len(recorded)
                    if recorded and all(row['full_metrics']['cache_write_complete'] for row in recorded) else None,
                    'cost_usd': sum(row['full_metrics']['cost_usd'] for row in recorded) / len(recorded)
                    if recorded and all(row['full_metrics']['cost_complete'] for row in recorded) else None,
                    'tokens_known_mean': sum(row['full_metrics']['tokens'] for row in recorded) / len(recorded) if recorded else None,
                    'cost_usd_known_mean': sum(row['full_metrics']['cost_usd'] for row in recorded) / len(recorded)
                    if recorded and any(row['full_metrics']['priced_calls'] for row in recorded) else None,
                    'tokens_complete_samples': sum(row['full_metrics']['cache_write_complete'] for row in recorded),
                    'cost_complete_samples': sum(row['full_metrics']['cost_complete'] for row in recorded),
                    'cost_priced_samples': sum(row['full_metrics']['priced_calls'] > 0 for row in recorded)}
        return {'turns': len(rows), 'status_counts': dict(Counter(row['status'] for row in rows)),
                'metrics': _summary(events, seconds), 'tool_calls_known': len(tools),
                'tool_calls': len(tools) if complete_tools else None,
                'tools_per_turn': len(tools) / len(rows) if rows and complete_tools else None,
                'duration_p50': _quantile(durations, .5), 'duration_p95': _quantile(durations, .95),
                'duration_samples': len(durations), 'duration_boundary_quality': dict(Counter(row['boundary_quality'] for row in timed)),
                'full_turns': sum(row['full_window'] for row in rows), 'per_turn': per_turn}

    @staticmethod
    def _tools(rows, tools):
        grouped = defaultdict(list)
        for tool in tools:
            grouped[tool['tool_name']].append(tool)
        values = []
        for name, calls in sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0])):
            durations = [_duration(call) for call in calls if _duration(call) is not None]
            values.append({'tool_name': name, 'calls': len(calls), 'status_counts': dict(Counter(c['status'] for c in calls)),
                           'duration_p50': _quantile(durations, .5), 'duration_p95': _quantile(durations, .95),
                           'duration_samples': len(durations)})
        return {'coverage': 'complete' if rows and all(row['tool_coverage'] == 'complete' for row in rows) else 'partial',
                'scope': 'selected_turns', 'status_counts': dict(Counter(t['status'] for t in tools)), 'rows': values}

    def turns(self, request, offset=0, limit=50, sort='start', order='desc', include_rows=True):
        if offset < 0 or not 1 <= limit <= 200:
            raise ValueError('offset must be nonnegative and limit must be 1..200')
        if sort not in TURN_SORTS or order not in ('asc', 'desc'):
            raise ValueError('invalid turn sort or order')
        query = self.query
        with query.index.read_snapshot() as conn:
            start, end = query._window(conn, request)
            edges = _bucket_edges(start, end, request.timezone, request.bucket)
            rows, events, tools, unassigned = self._load(conn, request, start, end)
            edge_us = [_us(edge) for edge in edges]
            row_buckets: list[list[dict]] = [[] for _ in edges[:-1]]
            event_buckets: list[list[dict]] = [[] for _ in edges[:-1]]
            tool_buckets: list[list[dict]] = [[] for _ in edges[:-1]]
            for source, destination, timestamp in ((rows, row_buckets, 'activity_us'), (events, event_buckets, 'timestamp_us'), (tools, tool_buckets, 'start_us')):
                for item in source:
                    moment = item[timestamp]
                    if source is tools and moment < _us(start):
                        moment = item['end_us']
                    position = min(len(destination)-1, max(0, bisect.bisect_right(edge_us, moment) - 1))
                    destination[position].append(item)
            trend = []
            complete_tools = bool(rows) and all(row['tool_coverage'] == 'complete' for row in rows)
            for i in range(len(edges)-1):
                seconds = _bucket_seconds(start, end, edges[i], edges[i+1])
                bucket_summary = self._summary(row_buckets[i], event_buckets[i], tool_buckets[i], seconds)
                bucket_summary['tool_calls'] = len(tool_buckets[i]) if complete_tools else None
                trend.append({'start': _iso(edges[i]), 'end': _iso(edges[i+1]),
                              'window_start': _iso(max(start, edges[i])), 'window_end': _iso(min(end, edges[i+1])),
                              'seconds': seconds, **bucket_summary})
            coverage = {'boundary_quality': dict(Counter(row['boundary_quality'] for row in rows)),
                        'tool_coverage': dict(Counter(row['tool_coverage'] for row in rows)),
                        'truncated_turns': sum(not row['full_window'] for row in rows),
                        'usage_quality': dict(Counter(event['quality'] for event in events)),
                        'unassigned_calls': unassigned, 'usage_scope': _scope(request.filters)}
            rows = _sort_turns(rows, sort, order)
            return labelled(conn, {'snapshot': query._snapshot(conn), 'query': query._query(request, start, end), 'sort': sort, 'order': order,
                    'summary': self._summary(rows, events, tools, (end-start).total_seconds()),
                    'trend': {'buckets': trend}, 'tools': self._tools(rows, tools), 'rows': rows[offset:offset+limit] if include_rows else [],
                    'total': len(rows), 'offset': offset, 'limit': limit, 'coverage': coverage})

    def turn_detail(self, harness, sid, turn_id, request=None):
        request = request or QueryRequest()
        query = self.query
        with query.index.read_snapshot() as conn:
            turn_row = conn.execute('SELECT * FROM turns WHERE harness=? AND session_id=? AND turn_id=?', (harness, sid, turn_id)).fetchone()
            if turn_row is None:
                return None
            turn = dict(turn_row)
            if not _matches(turn, request.filters, direct_only=True):
                return None
            start, end = query._window(conn, request)
            start_us, end_us = _us(start), _us(end)
            # Full recorded turn calls are returned for tracing, even when the
            # global window clips the turn. The window subtotal remains separate.
            bounds = conn.execute('SELECT MIN(timestamp_us),MAX(timestamp_us) FROM events WHERE harness=? AND session_id=? AND turn_id=?', (harness, sid, turn_id)).fetchone()
            calls = []
            if bounds[0] is not None:
                left = datetime.fromtimestamp(bounds[0]/1e6, UTC)
                right = datetime.fromtimestamp((bounds[1]+1)/1e6, UTC)
                filters = {**request.filters, 'harness': [harness], 'session': [sid]}
                calls = [event for event in query._events(conn, left, right, filters) if event.get('turn_id') == turn_id]
            window_calls = [event for event in calls if start_us <= event['timestamp_us'] < end_us]
            if CALL_FILTERS.intersection(request.filters) and not window_calls:
                return None
            tools = [dict(row) for row in conn.execute('SELECT * FROM tool_calls WHERE harness=? AND session_id=? AND turn_id=? ORDER BY start_us,key', (harness, sid, turn_id))]
            if not (_boundary_in_window(turn, start_us, end_us) or window_calls or
                    any(_boundary_in_window(tool, start_us, end_us) for tool in tools)):
                return None
            turn.update(start=_iso(datetime.fromtimestamp(turn['start_us']/1e6, UTC)),
                        end=_iso(datetime.fromtimestamp(turn['end_us']/1e6, UTC)) if turn['end_us'] is not None else None,
                        duration_seconds=_duration(turn))
            related = []
            if turn.get('root_turn_id'):
                related = [dict(row) for row in conn.execute('''SELECT harness,session_id,turn_id,parent_session_id,root_turn_id,status
                              FROM turns WHERE harness=? AND (turn_id=? OR root_turn_id=?)
                              AND NOT (session_id=? AND turn_id=?) ORDER BY start_us''',
                              (harness, turn['root_turn_id'], turn['root_turn_id'], sid, turn_id))]
            else:
                related = [dict(row) for row in conn.execute('''SELECT harness,session_id,turn_id,parent_session_id,root_turn_id,status
                              FROM turns WHERE harness=? AND root_turn_id=? ORDER BY start_us''', (harness, turn_id))]
            recorded = _summary(calls, _duration(turn))
            recorded['scope'] = 'whole_turn_recorded_subtotal'
            recorded['recorded_usage_available'] = bool(calls)
            recorded['boundary_quality'] = turn['boundary_quality']
            recorded['usage_quality'] = dict(Counter(event['quality'] for event in calls))
            overlap_seconds = _bucket_seconds(start, end, datetime.fromtimestamp(turn['start_us']/1e6, UTC),
                                               datetime.fromtimestamp(turn['end_us']/1e6, UTC) if turn['end_us'] is not None else end)
            return labelled(conn, {'snapshot': query._snapshot(conn), 'query': query._query(request, start, end), 'turn': turn,
                    'calls': [_public_event(event, start_us, end_us) for event in calls],
                    'tools': [_public_tool(tool, start_us, end_us) for tool in tools],
                    'window_metrics': _summary(window_calls, overlap_seconds), 'recorded_metrics': recorded,
                    'usage_scope': _scope(request.filters), 'related_turns': related})
