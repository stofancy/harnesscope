"""Calendar billing, local-day boundaries and one-snapshot response regressions."""

from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime
import json

import pytest
from starlette.testclient import TestClient

from harnesscope.domain import UsageEvent
from harnesscope.index import EVENT_COLUMNS, SQLiteIndex
from harnesscope.query import AnalyticsQuery, QueryRequest
from harnesscope.server import create_app

PRICES = {'known': {'inputCostPerMillion': 2, 'cacheReadCostPerMillion': 0.5,
                    'cacheWriteCostPerMillion': 3, 'cacheWrite1hCostPerMillion': 4,
                    'outputCostPerMillion': 8},
          'no-write': {'inputCostPerMillion': 2},
          'no-long': {'inputCostPerMillion': 2, 'cacheWriteCostPerMillion': 3}}
NOW = '2026-10-06T01:00:00+08:00'


def event(key, stamp='2025-01-01T12:00:00Z', **kwargs):
    defaults = dict(harness='codex', session_id='s', model='known', input_net=100,
                    cache_read=10, cache_write=0, output=20)
    return UsageEvent(key=key, timestamp_us=int(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1e6),
                      **(defaults | kwargs))


def database(tmp_path, events=()):
    index = SQLiteIndex(tmp_path / 'calendar.sqlite3')
    with index._transaction() as conn:
        rows = []
        for item in events:
            row = asdict(item)
            row['extra_tokens'] = json.dumps(row['extra_tokens'])
            rows.append(row)
        index._upsert(conn, 'events', EVENT_COLUMNS, rows)
        index._bump(conn)
    return index, AnalyticsQuery(index, PRICES)


def test_calendar_price_eligibility_and_all_source_totals_match_analytics(tmp_path):
    records = [
        event('standard', account_ref='account-a'),
        event('other-account', harness='omp', account_ref='account-b', service_tier='fast'),
        event('ttl', harness='claude', cache_write=30, extra_tokens={'cache_write_1h': 20}),
        event('negative-long', cache_write=5, extra_tokens={'cache_write_1h': -2}),
        event('negative-components', input_net=-2, cache_read=-3, output=-4, cache_write=-1),
        event('zero-write', model='no-write'),
        event('missing-write-price', model='no-write', cache_write=1),
        event('zero-long', model='no-long', cache_write=5),
        event('missing-long-price', model='no-long', cache_write=5, extra_tokens={'cache_write_1h': 2}),
        event('missing-negative-long-price', model='no-long', cache_write=0, extra_tokens={'cache_write_1h': -2}),
        event('invalid-long', cache_write=2, extra_tokens={'cache_write_1h': 3}),
        event('unknown-write', cache_write=None),
        event('unknown-model', harness='dsh', model='unpriced', source_cost_usd='99'),
        event('unknown-day', '2025-01-03T12:00:00Z', model='unpriced'),
    ]
    _, query = database(tmp_path, records)
    calendar = query.calendar(2025, now=NOW)
    analysis = query.analytics(QueryRequest(start=calendar['start'], end=calendar['end'], bucket='day'))
    for key in ('tokens', 'calls', 'priced_calls', 'unpriced_calls', 'cost_complete', 'cache_write_complete'):
        assert calendar['summary'][key] == analysis['summary'][key]
    assert calendar['summary']['cost_usd_known'] == pytest.approx(analysis['summary']['cost_usd'], abs=1e-12)
    for day, bucket in zip(calendar['days'], analysis['trend']['buckets']):
        assert day['date'] == bucket['label']
        assert day['metrics']['tokens'] == bucket['metrics']['tokens']
        assert day['metrics']['cost_usd_known'] == pytest.approx(bucket['metrics']['cost_usd'], abs=1e-12)
    first = calendar['days'][0]['metrics']
    assert first['priced_calls'] == 7
    assert first['unpriced_calls'] == 6
    assert first['cost_complete'] is False and first['cache_write_complete'] is False
    assert calendar['days'][1]['metrics']['cost_usd'] == 0
    assert calendar['days'][2]['metrics']['cost_usd'] is None
    assert 'account-a' not in json.dumps(calendar)
    assert 'account-b' not in json.dumps(calendar)


def test_calendar_local_year_half_open_dst_and_leap_days(tmp_path):
    _, query = database(tmp_path, [event('before', '2024-12-31T15:59:59Z'),
                                 event('start', '2024-12-31T16:00:00Z'),
                                 event('last', '2025-12-31T15:59:59Z'),
                                 event('after', '2025-12-31T16:00:00Z')])
    calendar = query.calendar(2025, 'Asia/Singapore', now=NOW)
    assert calendar['start'] == '2024-12-31T16:00:00Z'
    assert calendar['end'] == '2025-12-31T16:00:00Z'
    assert calendar['summary']['calls'] == 2
    assert len(calendar['days']) == 365
    assert calendar['days'][0]['metrics']['calls'] == 1
    assert calendar['days'][-1]['metrics']['calls'] == 1
    dst = {day['date']: day for day in query.calendar(2025, 'America/New_York', now=NOW)['days']}
    for date, hours in [('2025-03-09', 23), ('2025-11-02', 25)]:
        day = dst[date]
        delta = datetime.fromisoformat(day['end']) - datetime.fromisoformat(day['start'])
        assert delta.total_seconds() == hours * 3600
    leap = query.calendar(2024, now=NOW)
    assert len(leap['days']) == 366
    assert any(day['date'] == '2024-02-29' for day in leap['days'])


def test_calendar_current_year_cutoff_and_empty_cost(tmp_path):
    _, query = database(tmp_path, [event('inside', '2026-10-05T16:59:59Z'),
                                 event('cutoff', '2026-10-05T17:00:00Z')])
    calendar = query.calendar(2026, 'Asia/Singapore', now=NOW)
    assert calendar['end'] == '2026-10-05T17:00:00Z'
    assert calendar['days'][-1]['date'] == '2026-10-06'
    assert calendar['days'][-1]['end'] == '2026-10-06T16:00:00Z'
    assert calendar['days'][-1]['window_end'] == calendar['end']
    assert calendar['summary']['calls'] == 1
    assert calendar['days'][0]['metrics']['cost_usd'] == 0
    with pytest.raises(ValueError):
        query.calendar(2027, now=NOW)
    with pytest.raises(ValueError):
        query.calendar(2026, 'Bad/Timezone', now=NOW)


def test_calendar_snapshot_survives_writer_commit(tmp_path):
    index, _ = database(tmp_path, [event('one'), event('two', '2025-01-02T12:00:00Z')])
    original = index.snapshot_id

    class OverlappingIndex:
        @contextmanager
        def read_snapshot(self):
            with index.read_snapshot() as conn:
                conn.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()
                with index._transaction() as writer:
                    writer.execute('UPDATE events SET output=999')
                    index._bump(writer)
                yield conn

    calendar = AnalyticsQuery(OverlappingIndex(), PRICES).calendar(2025, now=NOW)
    assert calendar['snapshot']['id'] == str(original)
    assert calendar['summary']['tokens'] == 260
    assert index.snapshot_id > original


def test_calendar_http_contract_rejects_filters_and_duplicates(tmp_path):
    _, query = database(tmp_path, [event('one')])

    class Service:
        def calendar(self, year, timezone):
            return query.calendar(year, timezone, now=NOW)

        def close(self):
            pass

    with TestClient(create_app(Service(), initial_refresh=False), base_url='http://127.0.0.1') as client:
        result = client.get('/api/calendar?year=2025&timezone=Asia/Singapore')
        assert result.status_code == 200
        assert result.json()['year'] == 2025
        assert len(result.json()['days']) == 365
        for params in ('year=2025&harness=codex', 'year=2025&account=account-a',
                       'year=2025&year=2024', 'year=2025&timezone=UTC&timezone=UTC',
                       'year=no', ''):
            assert client.get('/api/calendar?' + params).status_code == 400
