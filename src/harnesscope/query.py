"""Snapshot-consistent analytics over the local, source-independent event index."""
from __future__ import annotations

import bisect
import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone as utc_timezone
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .names import labelled
from .pricing import _lookup_hit, load_pricing, model_cost_detail

UTC = utc_timezone.utc
DIMENSIONS = ('harness', 'model', 'provider', 'project', 'agent_type', 'purpose', 'service_tier', 'session', 'account')
COLUMN = {d: {'session': 'session_id', 'account': 'account_ref'}.get(d, d) for d in DIMENSIONS}
ADDITIVE = ('cost_usd', 'tokens', 'calls', 'input', 'output', 'cache_read', 'cache_write')
RATE_METRICS = ('tpm', 'rpm', 'throughput_tps', 'rps')
METRICS = ADDITIVE + ('cache_hit_rate', 'cost_per_call', 'cost_per_mtok') + RATE_METRICS
MAX_BUCKETS = 2000
BUCKET_SECONDS = {'second': 1, '5second': 5, '10second': 10, '30second': 30, 'minute': 60, '5minute': 300, '15minute': 900, 'hour': 3600}


def _datetime(value):
    if value is None:
        return None
    try:
        dt = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (ValueError, TypeError) as exc:
        raise ValueError('start/end must be ISO 8601 timestamps') from exc
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError('start/end must include a UTC offset')
    return dt.astimezone(UTC)


def _iso(dt):
    return dt.astimezone(UTC).isoformat().replace('+00:00', 'Z')


def _us(dt):
    return int(dt.timestamp() * 1_000_000)


@dataclass(frozen=True)
class QueryRequest:
    start: datetime | str | None = None
    end: datetime | str | None = None
    timezone: str = 'UTC'
    bucket: str = 'day'
    group_by: str | Sequence[str] = 'harness'
    metric: str = 'cost_usd'
    filters: Mapping[str, Sequence[str]] = field(default_factory=dict)
    members: Sequence[str] = ()

    def __post_init__(self):
        start, end = _datetime(self.start), _datetime(self.end)
        if (start is None) != (end is None):
            raise ValueError('start and end must be provided together')
        if start and start >= end:
            raise ValueError('start must precede end')
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError('unknown IANA timezone') from exc
        if self.bucket not in (*BUCKET_SECONDS, 'auto', 'day', 'week', 'month'):
            raise ValueError('unsupported time bucket')
        groups = tuple(self.group_by.split(',')) if isinstance(self.group_by, str) else tuple(self.group_by)
        if not 1 <= len(groups) <= 3 or len(set(groups)) != len(groups) or any(g not in DIMENSIONS for g in groups):
            raise ValueError('group_by must contain 1 to 3 distinct dimensions')
        if self.metric not in METRICS:
            raise ValueError('unsupported metric')
        if any(d not in DIMENSIONS for d in self.filters):
            raise ValueError('unsupported filter dimension')
        filters = {d: tuple(str(v) for v in ([values] if isinstance(values, str) else values))
                   for d, values in self.filters.items() if values}
        object.__setattr__(self, 'start', start)
        object.__setattr__(self, 'end', end)
        object.__setattr__(self, 'group_by', groups)
        object.__setattr__(self, 'filters', filters)
        object.__setattr__(self, 'members', tuple(dict.fromkeys(self.members)))

    @classmethod
    def from_params(cls, params):
        def values(key):
            value = params.get(key, ())
            return [value] if isinstance(value, str) else list(value)
        def first(key, default=None):
            choices = values(key)
            return choices[-1] if choices else default
        return cls(start=first('start'), end=first('end'), timezone=first('timezone', 'UTC'),
                   bucket=first('bucket', 'day'), group_by=first('group_by', 'harness'),
                   metric=first('metric', 'cost_usd'), members=values('member'),
                   filters={d: values(d) for d in DIMENSIONS if values(d)})


def _where(start, end, filters, *, exclude=None, prefix=''):
    clauses = [f'{prefix}timestamp_us >= ?', f'{prefix}timestamp_us < ?']
    args = [_us(start), _us(end)]
    for dim, values in filters.items():
        if dim == exclude:
            continue
        col = COLUMN[dim]
        clauses.append(f"COALESCE({prefix}{col}, '') IN ({','.join('?' for _ in values)})")
        args.extend(values)
    return ' AND '.join(clauses), args


def _resolved_bucket(start, end, bucket):
    if bucket != 'auto':
        return bucket
    seconds = (end - start).total_seconds()
    for candidate, width in [('minute', 60), ('5minute', 300), ('15minute', 900), ('hour', 3600),
                             ('day', 86400), ('week', 604800)]:
        if seconds <= width * 120:
            return candidate
    return 'month'


def _bucket_seconds(start, end, left, right):
    return max(0.0, (min(end, right) - max(start, left)).total_seconds())


def _bucket_edges(start, end, tzname, bucket):
    bucket = _resolved_bucket(start, end, bucket)
    zone = ZoneInfo(tzname)
    local = start.astimezone(zone)
    if bucket in BUCKET_SECONDS:
        width = BUCKET_SECONDS[bucket]
        if width >= 60:
            local = local.replace(minute=(local.minute // (width // 60)) * (width // 60), second=0, microsecond=0)
        else:
            local = local.replace(second=(local.second // width) * width, microsecond=0)
    else:
        local = local.replace(hour=0, minute=0, second=0, microsecond=0)
        if bucket == 'week':
            local -= timedelta(days=local.weekday())
        elif bucket == 'month':
            local = local.replace(day=1)
    current = local.astimezone(UTC)
    edges = [current]
    while current < end:
        if len(edges) > MAX_BUCKETS:
            raise ValueError(f'time window exceeds {MAX_BUCKETS} buckets')
        if bucket in BUCKET_SECONDS:
            # UTC arithmetic preserves both occurrences of a repeated DST hour.
            nxt = current + timedelta(seconds=BUCKET_SECONDS[bucket])
        else:
            wall = current.astimezone(zone)
            if bucket == 'month':
                nxtwall = wall.replace(year=wall.year + (wall.month == 12), month=wall.month % 12 + 1)
            else:
                nxtwall = wall + timedelta(days=7 if bucket == 'week' else 1)
            nxt = nxtwall.astimezone(UTC)
        if nxt <= current:
            raise ValueError('timezone produced a non-increasing bucket')
        edges.append(nxt)
        current = nxt
    return edges


def _member(event, dimensions):
    values = [str(event.get(COLUMN[d]) or '') for d in dimensions]
    key_values = [str(event['harness']), *values] if 'session' in dimensions and 'harness' not in dimensions else values
    key = key_values[0] if len(key_values) == 1 else json.dumps(key_values, ensure_ascii=False, separators=(',', ':'))
    labels = key_values if 'session' in dimensions else values
    identity = dict(zip(dimensions, values))
    if 'session' in dimensions:
        identity['harness'] = str(event['harness'])
    return key, ' / '.join(value or 'Unknown' for value in labels), identity


def _summary(events, seconds=None):
    net = sum(e['input_net'] for e in events)
    read = sum(e['cache_read'] for e in events)
    write = sum(e['cache_write'] or 0 for e in events)
    complete_write = all(e['cache_write'] is not None for e in events)
    inp = net + read + write
    output = sum(e['output'] for e in events)
    priced = sum(e['_cost'] is not None for e in events)
    cost = sum(e['_cost'] or 0.0 for e in events)
    calls = len(events)
    cost_complete = priced == calls
    source_costs: dict[str, float] = defaultdict(float)
    for event in events:
        if event.get('source_cost_usd') is not None:
            source_costs[event.get('source_cost_kind') or 'unknown'] += float(event['source_cost_usd'])
    return {'calls': calls, 'input_net': net, 'input': inp, 'output': output, 'tokens': inp + output,
            'cache_read': read, 'cache_write': write if complete_write else None,
            'cache_write_known': write, 'cache_write_complete': complete_write,
            'cache_hit_rate': read / inp if inp and complete_write else None,
            'cost_usd': cost, 'cost_complete': cost_complete, 'priced_calls': priced,
            'unpriced_calls': calls - priced,
            'cost_per_call': cost / calls if calls and cost_complete else None,
            'cost_per_mtok': cost / (inp + output) * 1e6 if inp + output and cost_complete and complete_write else None,
            'sessions': len({(e['harness'], e['session_id']) for e in events}),
            'account_known_calls': sum(bool(e.get('account_ref')) for e in events),
            'account_unknown_calls': sum(not e.get('account_ref') for e in events),
            'source_cost_usd': source_costs.get('api_estimate', 0.0),
            'source_cost_calls': sum(e.get('source_cost_usd') is not None and e.get('source_cost_kind') == 'api_estimate' for e in events),
            'source_cost_by_kind': dict(source_costs),
            'source_total': sum(e['source_total'] or 0 for e in events),
            'source_total_calls': sum(e['source_total'] is not None for e in events),
            'source_total_difference': sum(e['source_total'] - e['input_net'] - e['cache_read'] - e['cache_write'] - e['output']
                                           for e in events if e['source_total'] is not None and e['cache_write'] is not None),
            'seconds': seconds,
            'tpm': (inp + output) / seconds * 60 if seconds else None,
            'rpm': calls / seconds * 60 if seconds else None,
            'throughput_tps': (inp + output) / seconds if seconds else None,
            'rps': calls / seconds if seconds else None,
            'tps': []}


def _value(summary, metric, *, complete=False):
    if metric == 'cost_usd' and not summary['cost_complete']:
        if complete or not summary['priced_calls']:
            return None
    return summary[metric]


def _share(metrics, total, metric):
    numerator, denominator = _value(metrics, metric), _value(total, metric)
    return numerator / denominator if metric in ADDITIVE and numerator is not None and denominator else None


def _delta(current, previous):
    result = {}
    for metric in METRICS:
        now, old = _value(current, metric, complete=True), _value(previous, metric, complete=True)
        difference = now - old if now is not None and old is not None else None
        result[metric] = {'absolute': difference, 'relative': difference / old if difference is not None and old else None}
    known = current['cost_usd'] - previous['cost_usd']
    result['cost_usd_known'] = {'absolute': known, 'relative': known / previous['cost_usd'] if previous['cost_usd'] else None}
    return result


class AnalyticsQuery:
    def __init__(self, index, pricing=None):
        self.index = index
        self.pricing = {name: dict(record) for name, record in (load_pricing() if pricing is None else pricing).items()}
        self._price_matches = {}

    def _lookup_price(self, pricing, model):
        # The calculator owns a fixed price table. Cache misses as well as hits;
        # missing local model aliases otherwise repeatedly scan the full table.
        if model not in self._price_matches:
            self._price_matches[model] = _lookup_hit(pricing, model)
        return self._price_matches[model]

    def accounts(self):
        from .accounts import indexed_accounts
        with self.index.read_snapshot() as conn:
            return {**indexed_accounts(conn), 'snapshot': self._snapshot(conn)}

    def calendar(self, year: int, timezone: str = 'UTC', *, now=None):
        """Daily all-source totals without event objects, comparisons or facets.

        Pricing is linear within a model/tier and required-cache-price partition.
        The SQL partitions preserve per-event price eligibility before summing;
        the shared calculator still owns aliases, tier rates and cache fallbacks.
        """
        if type(year) is not int or not 1 <= year <= 9998:
            raise ValueError('year must be an integer from 1 to 9998')
        try:
            zone = ZoneInfo(timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError('unknown IANA timezone') from exc
        current = _datetime(now) if now is not None else datetime.now(UTC)
        if year > current.astimezone(zone).year:
            raise ValueError('year cannot be in the local future')
        start = datetime(year, 1, 1, tzinfo=zone).astimezone(UTC)
        end = min(datetime(year + 1, 1, 1, tzinfo=zone).astimezone(UTC), current)
        edges = _bucket_edges(start, end, timezone, 'day')
        sql = '''WITH days AS (
                SELECT CAST(key AS INTEGER) AS day, json_extract(value,'$[0]') AS left_us,
                    json_extract(value,'$[1]') AS right_us FROM json_each(?)),
            components AS (
                SELECT day,model,service_tier,input_net,cache_read,cache_write,output,
                    COALESCE(json_extract(extra_tokens,'$.cache_write_1h'),0) AS long_write
                FROM days JOIN events ON timestamp_us>=left_us AND timestamp_us<right_us),
            totals AS (SELECT day,model,service_tier,
                cache_write IS NOT NULL AS known_write,
                long_write>MAX(0,COALESCE(cache_write,0)) AS invalid_long,
                CASE WHEN long_write<0 THEN -1 WHEN long_write>0 THEN 1 ELSE 0 END AS long_sign,
                cache_write-long_write>0 AS short_required,
                COUNT(*) AS calls,
                SUM(input_net+cache_read+COALESCE(cache_write,0)+output) AS tokens,
                SUM(MAX(0,input_net)) AS cost_input,
                SUM(MAX(0,cache_read)) AS cost_read,
                SUM(MAX(0,output)) AS cost_output,
                SUM(MAX(0,COALESCE(cache_write,0)-long_write)) AS cost_short,
                SUM(long_write) AS cost_long
            FROM components
            GROUP BY day,model,service_tier,known_write,invalid_long,long_sign,short_required)'''
        columns = ('day', 'model', 'service_tier', 'known_write', 'invalid_long', 'calls',
                   'tokens', 'cost_input', 'cost_read', 'cost_output', 'cost_short', 'cost_long')
        # SQLite's row iterator releases/reacquires the GIL for every row. Transfer
        # the small grouped result as one JSON value so an abandoned analytics
        # request doing Python work cannot delay every day and every pricing row.
        pairs = ','.join(f"'{column}',{column}" for column in columns)
        sql += f' SELECT json_group_array(json_object({pairs})) FROM totals'

        def metrics():
            return {'tokens': 0, 'calls': 0, 'cost_usd': 0.0, 'cost_usd_known': 0.0,
                    'priced_calls': 0, 'unpriced_calls': 0, 'cost_complete': True,
                    'cache_write_complete': True}

        summary = metrics()
        ranges = [(left, right, max(start, left), min(end, right))
                  for left, right in zip(edges, edges[1:])]
        day_metrics = [metrics() for _ in ranges]
        boundaries = json.dumps([[_us(window_start), _us(window_end)]
                                 for _, _, window_start, window_end in ranges])
        with self.index.read_snapshot() as conn:
            # Establish the revision and all daily reads in one SQLite snapshot.
            snapshot = self._snapshot(conn)
            rows = json.loads(conn.execute(sql, (boundaries,)).fetchone()[0])
        for row in rows:
            day = day_metrics[row['day']]
            calls = row['calls']
            day['tokens'] += row['tokens']
            day['calls'] += calls
            day['cache_write_complete'] &= bool(row['known_write'])
            detail = None
            if row['known_write'] and not row['invalid_long']:
                detail = model_cost_detail(
                    self.pricing, row['model'], row['cost_input'], row['cost_read'],
                    row['cost_output'], tier=row['service_tier'], config_tier='default',
                    cache_write=row['cost_short'] + row['cost_long'],
                    cache_write_1h=row['cost_long'], _lookup=self._lookup_price,
                )
            cost = detail['cost_usd'] if detail else None
            if cost is None or not math.isfinite(cost):
                day['unpriced_calls'] += calls
            else:
                day['priced_calls'] += calls
                day['cost_usd_known'] += cost
        days = []
        for (left, right, window_start, window_end), day in zip(ranges, day_metrics):
            day['cost_complete'] = day['unpriced_calls'] == 0
            day['cost_usd'] = (None if day['calls'] and not day['priced_calls']
                               else day['cost_usd_known'])
            for key in ('tokens', 'calls', 'priced_calls', 'unpriced_calls', 'cost_usd_known'):
                summary[key] += day[key]
            summary['cache_write_complete'] &= day['cache_write_complete']
            days.append({'date': left.astimezone(zone).date().isoformat(),
                         'start': _iso(left), 'end': _iso(right),
                         'window_start': _iso(window_start), 'window_end': _iso(window_end),
                         'metrics': day})
        summary['cost_complete'] = summary['unpriced_calls'] == 0
        summary['cost_usd'] = (None if summary['calls'] and not summary['priced_calls']
                               else summary['cost_usd_known'])
        return {'snapshot': snapshot, 'year': year, 'timezone': timezone,
                'start': _iso(start), 'end': _iso(end), 'summary': summary, 'days': days}

    def turns(self, request, offset=0, limit=50, sort='start', order='desc', include_rows=True):
        from .turn_query import TurnQuery
        return TurnQuery(self).turns(request, offset=offset, limit=limit, sort=sort, order=order, include_rows=include_rows)

    def usage(self, request, group='request', offset=0, limit=50, sort='time', order='desc', turn_ids=()):
        from .usage_query import UsageQuery
        return UsageQuery(self).usage(request, group=group, offset=offset, limit=limit, sort=sort, order=order, turn_ids=turn_ids)

    def turn_detail(self, harness, sid, turn_id, request=None):
        from .turn_query import TurnQuery
        return TurnQuery(self).turn_detail(harness, sid, turn_id, request)

    @staticmethod
    def _snapshot(conn):
        row = conn.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()
        return {'id': str(row[0]) if row else '0'}

    @staticmethod
    def _window(conn, request):
        if request.start is not None:
            return request.start, request.end
        row = conn.execute('SELECT MIN(timestamp_us), MAX(timestamp_us) FROM events').fetchone()
        if row[0] is None:
            now = datetime.now(UTC)
            return now.replace(hour=0, minute=0, second=0, microsecond=0), now + timedelta(microseconds=1)
        return datetime.fromtimestamp(row[0] / 1e6, UTC), datetime.fromtimestamp(row[1] / 1e6, UTC) + timedelta(microseconds=1)

    def _events(self, conn, start, end, filters, turn_ids=()):
        clause, args = _where(start, end, filters)
        if turn_ids:
            clause += f" AND COALESCE(turn_id,'') IN ({','.join('?' for _ in turn_ids)})"
            args.extend(turn_ids)
        events = [dict(row) for row in conn.execute(f'SELECT * FROM events WHERE {clause} ORDER BY timestamp_us,key', args)]
        for event in events:
            extra = event.get('extra_tokens') or '{}'
            event['extra_tokens'] = json.loads(extra) if isinstance(extra, str) else extra
            detail = model_cost_detail(self.pricing, event['model'], event['input_net'], event['cache_read'], event['output'],
                                       tier=event['service_tier'], config_tier='default',
                                       cache_write=event['cache_write'] or 0,
                                       cache_write_1h=event['extra_tokens'].get('cache_write_1h', 0),
                                       _lookup=self._lookup_price)
            event['_cost'] = detail['cost_usd'] if detail and event['cache_write'] is not None else None
            if event['_cost'] is not None and not math.isfinite(event['_cost']):
                event['_cost'] = None
            event['_cost_detail'] = detail
        return events

    @staticmethod
    def _timing(conn, start, end, filters, with_samples=False):
        samples = [dict(row) for row in conn.execute(
            'SELECT * FROM timing_samples WHERE start_us>=? AND end_us<=? AND end_us>start_us',
            (_us(start), _us(end)))]
        if not samples:
            return ([], []) if with_samples else []
        # Response timing binds to an exact event key. Turn timing can contain
        # several usage records and is admitted only when every member passes.
        by_key, grouped, stamps = {}, defaultdict(list), {}
        if filters:
            columns = ','.join(dict.fromkeys(['key', 'timestamp_us', 'harness', 'session_id', 'model', 'provider', 'turn_id', 'output', *COLUMN.values()]))
            for row in conn.execute(f'SELECT {columns} FROM events WHERE timestamp_us>=? AND timestamp_us<=? ORDER BY timestamp_us',
                                    (_us(start), _us(end))):
                event = dict(row)
                by_key[(event['harness'], event['key'])] = event
                identity = (event['harness'], event['session_id'], event['model'], event['provider'], event.get('turn_id'))
                grouped[identity].append(event)
            stamps = {key: [e['timestamp_us'] for e in value] for key, value in grouped.items()}
        totals: dict[tuple[str, str], dict[str, Any]] = {}
        admitted = []
        for sample in samples:
            if filters:
                if sample['kind'] == 'model':
                    matching = [by_key[(sample['harness'], sample['key'])]] if (sample['harness'], sample['key']) in by_key else []
                else:
                    identity = (sample['harness'], sample['session_id'], sample['model'], sample['provider'], sample.get('turn_id'))
                    times = stamps.get(identity, [])
                    lo = bisect.bisect_left(times, sample['start_us'])
                    hi = bisect.bisect_right(times, sample['end_us'])
                    matching = grouped.get(identity, [])[lo:hi]
                    if sum(e['output'] for e in matching) != sample['output']:
                        continue
                if not matching or any(any(str(e.get(COLUMN[d]) or '') not in values for d, values in filters.items()) for e in matching):
                    continue
            admitted.append(sample)
            timing_identity = (sample['harness'], sample['kind'])
            item = totals.setdefault(timing_identity, {'harness': timing_identity[0], 'kind': timing_identity[1], 'output': 0, 'seconds': 0.0, 'samples': 0})
            item['output'] += sample['output']
            item['seconds'] += (sample['end_us'] - sample['start_us']) / 1e6
            item['samples'] += 1
        result = [{**item, 'tps': item['output'] / item['seconds']} for _, item in sorted(totals.items())]
        return (result, admitted) if with_samples else result

    @staticmethod
    def _facets(conn, start, end, filters, turn_ids=()):
        result = {}
        for dimension in DIMENSIONS:
            clause, args = _where(start, end, filters, exclude=dimension)
            if turn_ids:
                clause += f" AND COALESCE(turn_id,'') IN ({','.join('?' for _ in turn_ids)})"
                args.extend(turn_ids)
            column = COLUMN[dimension]
            result[dimension] = [row[0] for row in conn.execute(
                f"SELECT DISTINCT COALESCE({column},'') AS value FROM events WHERE {clause} ORDER BY value", args)]
        return result

    @staticmethod
    def _sources(conn):
        return [dict(row) for row in conn.execute('''SELECT f.harness,
                CASE WHEN MAX(error IS NOT NULL)=1 THEN 'error' WHEN SUM(warning_count)>0 THEN 'warning' ELSE 'indexed' END AS state,
                COUNT(*) AS files,
                (SELECT COUNT(*) FROM events e WHERE e.harness=f.harness) AS events,
                SUM(event_count) AS source_records,SUM(warning_count) AS warnings,
                SUM(CASE WHEN error IS NOT NULL AND error!='' THEN 1 ELSE 0 END) AS errors
                FROM files f GROUP BY f.harness ORDER BY f.harness''')]

    @staticmethod
    def _query(request, start, end):
        return {'start': _iso(start), 'end': _iso(end), 'timezone': request.timezone,
                'bucket': request.bucket, 'bucket_resolved': _resolved_bucket(start, end, request.bucket),
                'group_by': list(request.group_by), 'metric': request.metric,
                'filters': {key: list(values) for key, values in request.filters.items()}}

    def analytics(self, request):
        with self.index.read_snapshot() as conn:
            start, end = self._window(conn, request)
            edges = _bucket_edges(start, end, request.timezone, request.bucket)
            previous_start = start - (end - start)
            events = self._events(conn, previous_start, end, request.filters)
            current = [e for e in events if e['timestamp_us'] >= _us(start)]
            previous = [e for e in events if e['timestamp_us'] < _us(start)]
            window_seconds = (end - start).total_seconds()
            summary, previous_summary = _summary(current, window_seconds), _summary(previous, window_seconds)
            summary['tps'], timing_samples = self._timing(conn, start, end, request.filters, with_samples=True)
            previous_summary['tps'] = self._timing(conn, previous_start, start, request.filters)
            groups: dict[str, list[dict]] = defaultdict(list)
            prev_groups: dict[str, list[dict]] = defaultdict(list)
            identities = {}
            for source, target in ((current, groups), (previous, prev_groups)):
                for event in source:
                    key, label, dimensions = _member(event, request.group_by)
                    target[key].append(event)
                    identities[key] = {'key': key, 'label': label, 'dimensions': dimensions}
            summaries = {key: _summary(groups[key], window_seconds) for key in identities}
            previous_summaries = {key: _summary(prev_groups[key], window_seconds) for key in identities}
            ranked = sorted(identities, key=lambda key: (-abs(_value(summaries[key], request.metric) or 0), key))
            breakdown = [{**identities[key], 'metrics': summaries[key], 'value': _value(summaries[key], request.metric),
                          'share': _share(summaries[key], summary, request.metric)} for key in ranked]
            selected = list(request.members) if request.members else ranked[:5]
            if len(selected) > 50:
                raise ValueError('at most 50 members can be compared')
            members = [{**identities.get(key, {'key': key, 'label': key or 'Unknown'})} for key in selected]
            members.append({'key': '__other__', 'label': 'Other'})
            buckets: list[list[dict]] = [[] for _ in edges[:-1]]
            edge_us = [_us(edge) for edge in edges]
            timing_members = [{'key': f'{harness}/{kind}', 'harness': harness, 'kind': kind, 'label': f'{harness} · {kind}'}
                              for harness, kind in sorted({(s['harness'], s['kind']) for s in timing_samples})]
            timing_buckets: list[dict[str, dict[str, Any]]] = [defaultdict(lambda: {'output': 0, 'seconds': 0.0, 'samples': 0}) for _ in buckets]
            for sample in timing_samples:
                position = min(len(buckets)-1, max(0, bisect.bisect_left(edge_us, sample['end_us']) - 1))
                slot = timing_buckets[position][f"{sample['harness']}/{sample['kind']}"]
                slot['output'] += sample['output']
                slot['seconds'] += (sample['end_us'] - sample['start_us']) / 1e6
                slot['samples'] += 1
            for event in current:
                position = bisect.bisect_right(edge_us, event['timestamp_us']) - 1
                buckets[position].append(event)
            trend = []
            selected_set = set(selected)
            zone = ZoneInfo(request.timezone)
            resolved_bucket = _resolved_bucket(start, end, request.bucket)
            for i, bucket_events in enumerate(buckets):
                seconds = _bucket_seconds(start, end, edges[i], edges[i+1])
                total = _summary(bucket_events, seconds)
                series_events = defaultdict(list)
                for event in bucket_events:
                    key = _member(event, request.group_by)[0]
                    series_events[key if key in selected_set else '__other__'].append(event)
                series = []
                for member in members:
                    metrics = _summary(series_events[member['key']], seconds)
                    series.append({'key': member['key'], 'metrics': metrics, 'value': _value(metrics, request.metric),
                                   'share': _share(metrics, total, request.metric)})
                local = edges[i].astimezone(zone)
                label = local.isoformat(timespec='seconds' if resolved_bucket in ('second', '5second', '10second', '30second') else 'minutes') if resolved_bucket in BUCKET_SECONDS else local.date().isoformat()
                timed = []
                for member in timing_members:
                    slot = timing_buckets[i][member['key']]
                    timed.append({**member, **slot, 'value': slot['output'] / slot['seconds'] if slot['seconds'] else None})
                total['tps'] = [{'harness': x['harness'], 'kind': x['kind'], 'output': x['output'], 'seconds': x['seconds'],
                                 'samples': x['samples'], 'tps': x['value']} for x in timed if x['samples']]
                trend.append({'start': _iso(edges[i]), 'end': _iso(edges[i+1]), 'label': label, 'metrics': total,
                              'window_start': _iso(max(start, edges[i])), 'window_end': _iso(min(end, edges[i+1])), 'seconds': seconds,
                              'value': _value(total, request.metric), 'series': series, 'timed_tps': timed})
            deltas = _delta(summary, previous_summary)
            total_delta = deltas[request.metric]['absolute']
            comparison_members = []
            for key in ranked:
                delta = _delta(summaries[key], previous_summaries[key])
                difference = delta[request.metric]['absolute']
                contribution = difference / total_delta if request.metric in ADDITIVE and difference is not None and total_delta else None
                comparison_members.append({**identities[key], 'current': summaries[key], 'previous': previous_summaries[key],
                                           'delta': delta, 'contribution': contribution})
            coverage = {'events': len(current), 'priced_calls': summary['priced_calls'], 'unpriced_calls': summary['unpriced_calls'],
                        'priced_ratio': summary['priced_calls'] / len(current) if current else None,
                        'missing_price_models': sorted({e['model'] for e in current if e['_cost'] is None}),
                        'quality': dict(Counter(e['quality'] for e in current)), 'sources': self._sources(conn)}
            return labelled(conn, {'snapshot': self._snapshot(conn), 'query': self._query(request, start, end), 'summary': summary,
                    'trend': {'members': members, 'timing_members': timing_members, 'buckets': trend}, 'breakdown': breakdown, 'coverage': coverage,
                    'facets': self._facets(conn, start, end, request.filters),
                    'comparison': {'start': _iso(previous_start), 'end': _iso(start), 'summary': previous_summary,
                                   'delta': deltas, 'members': comparison_members,
                                   'cost_coverage_changed': (summary['cost_complete'] != previous_summary['cost_complete']
                                                             or summary['unpriced_calls'] != previous_summary['unpriced_calls']
                                                             or (summary['priced_calls'] / summary['calls'] if summary['calls'] else None)
                                                             != (previous_summary['priced_calls'] / previous_summary['calls'] if previous_summary['calls'] else None))}})

    def sessions(self, request, offset=0, limit=50):
        if offset < 0 or not 1 <= limit <= 200:
            raise ValueError('offset must be nonnegative and limit must be 1..200')
        with self.index.read_snapshot() as conn:
            start, end = self._window(conn, request)
            clause, args = _where(start, end, request.filters)
            total = conn.execute(f'SELECT COUNT(*) FROM (SELECT 1 FROM events WHERE {clause} GROUP BY harness,session_id)', args).fetchone()[0]
            keys = list(conn.execute(f'''SELECT harness,session_id,MAX(timestamp_us) AS last FROM events WHERE {clause}
                                        GROUP BY harness,session_id ORDER BY last DESC,harness,session_id LIMIT ? OFFSET ?''', [*args, limit, offset]))
            result = []
            for key in keys:
                filters = {**request.filters, 'harness': [key['harness']], 'session': [key['session_id']]}
                events = self._events(conn, start, end, filters)
                row = {'harness': key['harness'], 'session_id': key['session_id'], 'first': _iso(datetime.fromtimestamp(events[0]['timestamp_us']/1e6, UTC)),
                       'last': _iso(datetime.fromtimestamp(events[-1]['timestamp_us']/1e6, UTC)), 'metrics': _summary(events, (end-start).total_seconds())}
                for dimension in DIMENSIONS:
                    if dimension in ('harness', 'session'):
                        continue
                    row[dimension] = sorted({str(e[COLUMN[dimension]] or '') for e in events})
                result.append(row)
            return labelled(conn, {'snapshot': self._snapshot(conn), 'query': self._query(request, start, end), 'total': total,
                    'offset': offset, 'limit': limit, 'sessions': result})

    def session_detail(self, harness, sid, request=None):
        request = request or QueryRequest()
        with self.index.read_snapshot() as conn:
            start, end = self._window(conn, request)
            filters = {**request.filters, 'harness': [harness], 'session': [sid]}
            events = self._events(conn, start, end, filters)
            if not events:
                return None
            summary = _summary(events, (end-start).total_seconds())
            summary['tps'] = self._timing(conn, start, end, filters)
            children = [row[0] for row in conn.execute('SELECT DISTINCT session_id FROM events WHERE harness=? AND parent_session_id=? ORDER BY session_id', (harness, sid))]
            for event in events:
                event['cost_usd'] = event.pop('_cost')
                event['cost_detail'] = event.pop('_cost_detail')
            return labelled(conn, {'snapshot': self._snapshot(conn), 'query': self._query(request, start, end),
                    'session': {'harness': harness, 'session_id': sid, 'children': children},
                    'summary': summary, 'events': events})
