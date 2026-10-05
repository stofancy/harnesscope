"""Behavior checks for shared analytics; use the real SQLite snapshot schema."""
import json
from dataclasses import asdict
from datetime import datetime

import pytest

from codex_usage.domain import UsageEvent, TimingSample
from codex_usage.index import SQLiteIndex, EVENT_COLUMNS, TIMING_COLUMNS
from codex_usage.query import AnalyticsQuery, QueryRequest
from codex_usage.pricing import model_cost, records_from_modelsdev, records_from_litellm

PRICES = {'known': {'inputCostPerMillion': 2, 'cacheReadCostPerMillion': 0.5,
                    'cacheWriteCostPerMillion': 3, 'cacheWrite1hCostPerMillion': 4,
                    'outputCostPerMillion': 8}}


def us(value):
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1e6)


def event(key, stamp, **kwargs):
    defaults = dict(harness='codex', session_id='s1', model='known', input_net=100,
                    cache_read=0, cache_write=0, output=20)
    return UsageEvent(key=key, timestamp_us=us(stamp), **(defaults | kwargs))


def database(tmp_path, events=(), timing=()):
    index = SQLiteIndex(tmp_path / 'usage.sqlite3')
    with index._transaction() as conn:
        records = []
        for item in events:
            row = asdict(item)
            row['extra_tokens'] = json.dumps(row['extra_tokens'])
            records.append(row)
        index._upsert(conn, 'events', EVENT_COLUMNS, records)
        index._upsert(conn, 'timing_samples', TIMING_COLUMNS, [asdict(item) for item in timing])
        index._bump(conn)
    return AnalyticsQuery(index, PRICES)


def request(**kwargs):
    return QueryRequest(start='2026-10-01T00:00:00Z', end='2026-10-03T00:00:00Z', **kwargs)


def test_half_open_timezone_multiselect_and_cross_day(tmp_path):
    query = database(tmp_path, [event('before', '2026-09-30T23:59:59Z'),
                               event('start', '2026-10-01T00:00:00Z', model='a'),
                               event('b', '2026-10-01T17:00:00Z', model='b'),
                               event('other', '2026-10-01T20:00:00Z', harness='omp', model='a'),
                               event('c', '2026-10-02T00:00:00Z', model='c'),
                               event('end', '2026-10-03T00:00:00Z', model='a')])
    result = query.analytics(request(timezone='Asia/Singapore', metric='calls',
                                     filters={'model': ['a', 'b'], 'harness': ['codex']}))
    assert result['summary']['calls'] == 2
    assert [row['metrics']['calls'] for row in result['trend']['buckets']] == [1, 1, 0]
    assert result['trend']['buckets'][0]['start'] == '2026-09-30T16:00:00Z'
    # A dimension's own selected values do not hide its other candidates.
    assert result['facets']['model'] == ['a', 'b', 'c']
    assert result['facets']['harness'] == ['codex', 'omp']


@pytest.mark.parametrize('start,end,expected', [
    ('2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 23),
    ('2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 25)])
def test_dst_hour_buckets_include_each_actual_hour(tmp_path, start, end, expected):
    query = database(tmp_path)
    result = query.analytics(QueryRequest(start=start, end=end, timezone='America/New_York', bucket='hour', metric='calls'))
    buckets = result['trend']['buckets']
    assert len(buckets) == expected
    assert len({row['start'] for row in buckets}) == expected
    assert all(row['value'] == 0 for row in buckets)
    daily = query.analytics(QueryRequest(start=start, end=end, timezone='America/New_York', bucket='day'))
    assert len(daily['trend']['buckets']) == 1
    bucket = daily['trend']['buckets'][0]
    assert (us(bucket['end']) - us(bucket['start'])) / 3_600_000_000 == expected


def test_weighted_ratios_top_other_conservation_and_no_query_mutation(tmp_path):
    events = [event(str(i), '2026-10-01T01:00:00Z', model='known', provider=f'p{i}',
                    input_net=100 * (i+1), cache_read=50, cache_write=20, output=10) for i in range(7)]
    query = database(tmp_path, events)
    req = request(group_by='provider', metric='tokens')
    result = query.analytics(req)
    assert result == query.analytics(req)
    summary = result['summary']
    assert summary['cache_hit_rate'] == pytest.approx(350 / (2800 + 350 + 140))
    assert summary['cost_per_call'] == pytest.approx(summary['cost_usd'] / 7)
    assert summary['cost_per_mtok'] == pytest.approx(summary['cost_usd'] / summary['tokens'] * 1e6)
    assert len(result['breakdown']) == 7
    assert len(result['trend']['members']) == 6
    for bucket in result['trend']['buckets']:
        assert sum(row['value'] for row in bucket['series']) == bucket['value']
        assert [row['key'] for row in bucket['series']] == [m['key'] for m in result['trend']['members']]
    singled = query.analytics(request(group_by='provider', metric='tokens', members=['p0', 'p6']))
    assert [m['key'] for m in singled['trend']['members']] == ['p0', 'p6', '__other__']
    assert query.analytics(req) == result


def test_unknown_cost_known_subtotal_and_empty_bucket(tmp_path):
    query = database(tmp_path, [event('yes', '2026-10-01T01:00:00Z'),
                               event('no', '2026-10-01T02:00:00Z', model='unpriced')])
    result = query.analytics(QueryRequest(start='2026-10-01T00:00:00Z', end='2026-10-04T00:00:00Z', bucket='day'))
    assert result['summary']['cost_usd'] > 0
    assert result['summary']['cost_complete'] is False
    assert result['summary']['cost_per_call'] is None
    assert result['coverage']['missing_price_models'] == ['unpriced']
    assert result['trend']['buckets'][0]['value'] == result['summary']['cost_usd']
    assert result['trend']['buckets'][1]['value'] == 0
    unknown = query.analytics(request(filters={'model': ['unpriced']}))
    assert unknown['trend']['buckets'][0]['value'] is None
    assert unknown['comparison']['delta']['cost_usd']['absolute'] is None
    assert unknown['comparison']['delta']['cost_usd_known']['absolute'] == 0


def test_comparison_member_union_drops_and_zero_baseline(tmp_path):
    query = database(tmp_path, [event('old', '2026-09-30T01:00:00Z', provider='gone'),
                               event('new', '2026-10-01T01:00:00Z', provider='new', output=40)])
    result = query.analytics(request(group_by='provider', metric='output'))
    members = {m['key']: m for m in result['comparison']['members']}
    assert members['gone']['current']['calls'] == 0
    assert members['gone']['delta']['output'] == {'absolute': -20, 'relative': -1}
    assert members['new']['delta']['output'] == {'absolute': 40, 'relative': None}
    assert sum(m['contribution'] for m in members.values()) == pytest.approx(1)
    assert members['gone']['contribution'] == -1


def test_unknown_write_and_one_hour_price_are_not_fabricated(tmp_path):
    query = database(tmp_path, [event('write', '2026-10-01T00:00:00Z', cache_write=None)])
    result = query.analytics(request())
    assert result['summary']['cache_write'] is None
    assert result['summary']['cache_hit_rate'] is None
    assert result['summary']['cost_per_call'] is None
    assert model_cost(PRICES, 'known', 0, 0, 0, cache_write=100, cache_write_1h=50) == pytest.approx(0.00035)
    no_long = {'known': {key: value for key, value in PRICES['known'].items() if key != 'cacheWrite1hCostPerMillion'}}
    assert model_cost(no_long, 'known', 0, 0, 0, cache_write=100, cache_write_1h=50) is None
    assert model_cost({'known': {'inputCostPerMillion': 1}}, 'known', 0, 0, 0, cache_write=1) is None


def test_sessions_pagination_collision_and_body_free_detail(tmp_path):
    query = database(tmp_path, [event('a', '2026-10-01T01:00:00Z'),
                               event('b', '2026-10-01T02:00:00Z', harness='omp'),
                               event('c', '2026-10-01T03:00:00Z', session_id='child', parent_session_id='s1')])
    page = query.sessions(request(), offset=1, limit=1)
    assert page['total'] == 3
    assert page['sessions'][0]['harness'] == 'omp'
    detail = query.session_detail('codex', 's1', request())
    assert detail['summary']['calls'] == 1
    assert detail['session']['children'] == ['child']
    assert detail['snapshot'] == page['snapshot']
    assert '_cost' not in detail['events'][0]
    assert 'content' not in detail['events'][0]
    assert query.session_detail('dsh', 's1', request()) is None


def test_tps_complete_window_samples_and_definitions_stay_separate(tmp_path):
    events = [event('a', '2026-10-01T00:00:03Z'), event('b', '2026-10-01T00:00:03Z', harness='omp')]
    samples = [TimingSample('complete', 'codex', 's1', 'known', us('2026-10-01T00:00:01Z'), us('2026-10-01T00:00:03Z'), 20),
               TimingSample('clipped', 'codex', 's1', 'known', us('2026-09-30T23:59:59Z'), us('2026-10-01T00:00:03Z'), 80),
               TimingSample('omp', 'omp', 's1', 'known', us('2026-10-01T00:00:01Z'), us('2026-10-01T00:00:03Z'), 40, kind='generation')]
    result = database(tmp_path, events, samples).analytics(request())
    assert [(row['harness'], row['kind'], row['tps']) for row in result['summary']['tps']] == [('codex', 'end_to_end', 10), ('omp', 'generation', 20)]


def test_validation_bucket_budget_and_month_week_calendar(tmp_path):
    with pytest.raises(ValueError, match='UTC offset'):
        QueryRequest(start='2026-01-01', end='2026-02-01')
    with pytest.raises(ValueError, match='provided together'):
        QueryRequest(start='2026-01-01T00:00:00Z')
    query = database(tmp_path)
    with pytest.raises(ValueError, match='2000'):
        query.analytics(QueryRequest(start='2026-01-01T00:00:00Z', end='2026-05-01T00:00:00Z', bucket='hour'))
    result = query.analytics(QueryRequest(start='2026-01-15T00:00:00Z', end='2026-03-01T00:00:00Z', bucket='month'))
    assert [b['label'] for b in result['trend']['buckets']] == ['2026-01-01', '2026-02-01']
    result = query.analytics(QueryRequest(start='2026-10-01T00:00:00Z', end='2026-10-04T00:00:00Z', bucket='week'))
    assert result['trend']['buckets'][0]['label'] == '2026-09-28'


def test_provider_prices_preserve_cache_write_fields():
    models = records_from_modelsdev({'anthropic': {'models': {'claude-test': {'cost': {'input': 3, 'output': 15, 'cache_read': 0.3, 'cache_write': 3.75}}}}})
    assert models[0]['cacheWriteCostPerMillion'] == 3.75
    lite = records_from_litellm({'claude-test': {'input_cost_per_token': 3e-6, 'output_cost_per_token': 15e-6,
                              'cache_creation_input_token_cost': 3.75e-6, 'cache_creation_input_token_cost_above_1hr': 6e-6}})
    assert lite[0]['cacheWrite1hCostPerMillion'] == 6


def test_official_claude_cache_rules_and_explicit_overrides_do_not_mutate_prices():
    from codex_usage.pricing import model_cost_detail
    prices = {'claude-sonnet-4-6': {'inputCostPerMillion': 3, 'cacheReadCostPerMillion': 0.3, 'outputCostPerMillion': 15}}
    baseline = json.dumps(prices, sort_keys=True)
    detail = model_cost_detail(prices, 'claude-sonnet-4-6', 100, 200, 50, cache_write=300, cache_write_1h=100)
    assert detail['cost_usd'] == pytest.approx((100*3 + 200*.3 + 50*15 + 200*3.75 + 100*6) / 1e6)
    assert detail['cache_write_rule'] == 'anthropic-official-2026-10-05'
    assert json.dumps(prices, sort_keys=True) == baseline
    assert model_cost(prices, 'claude-sonnet-4-6-20250929', 0, 0, 0, cache_write=100) == pytest.approx(.000375)
    explicit = {'claude-sonnet-4-6': prices['claude-sonnet-4-6'] | {'cacheWriteCostPerMillion': 0, 'cacheWrite1hCostPerMillion': 1}}
    assert model_cost(explicit, 'claude-sonnet-4-6', 0, 0, 0, cache_write=200, cache_write_1h=100) == pytest.approx(.0001)
    invalid = {'claude-sonnet-4-6': prices['claude-sonnet-4-6'] | {'cacheWriteCostPerMillion': None}}
    assert model_cost(invalid, 'claude-sonnet-4-6', 0, 0, 0, cache_write=100) is None
    assert model_cost(prices, 'claude-custom-private', 0, 0, 0, cache_write=100) is None
    assert model_cost(prices, 'claude-sonnet-4-6', 0, 0, 0, cache_write=10, cache_write_1h=20) is None


def test_source_total_subsets_and_cost_definitions_stay_separate(tmp_path):
    query = database(tmp_path, [event('a', '2026-10-01T00:00:00Z', harness='omp', input_net=100,
                                    cache_read=20, cache_write=10, output=50, reasoning=40, source_total=190,
                                    extra_tokens={'orchestration_input': 10, 'cache_write_1h': 5},
                                    source_cost_usd='0.5', source_cost_kind='api_estimate'),
                               event('b', '2026-10-01T01:00:00Z', source_cost_usd='1.25', source_cost_kind='actual_bill')])
    summary = query.analytics(request())['summary']
    assert summary['tokens'] == 180 + 120
    assert summary['source_total_difference'] == 10
    assert summary['source_total_calls'] == 1
    assert summary['source_cost_usd'] == .5
    assert summary['source_cost_by_kind'] == {'api_estimate': .5, 'actual_bill': 1.25}


def test_source_coverage_does_not_double_count_mirror_records(tmp_path):
    query = database(tmp_path, [event('a', '2026-10-01T00:00:00Z')])
    with query.index._transaction() as conn:
        conn.execute("INSERT INTO files(path,harness,source_kind,event_count,state) VALUES ('original','codex','session',1,'{}')")
        conn.execute("INSERT INTO files(path,harness,source_kind,event_count,state) VALUES ('mirror','codex','session',1,'{}')")
    sources = query.analytics(request())['coverage']['sources']
    assert sources == [{'harness': 'codex', 'state': 'indexed', 'files': 2, 'events': 1, 'source_records': 2, 'warnings': 0, 'errors': 0}]


def test_tps_model_response_binding_and_whole_turn_filter(tmp_path):
    records = [event('main', '2026-10-01T00:00:10Z', harness='omp', purpose=None, output=100),
               event('aux', '2026-10-01T00:00:13Z', harness='omp', purpose='compaction', output=10),
               event('first', '2026-10-01T00:01:10Z', purpose='main', service_tier='standard', output=30),
               event('second', '2026-10-01T00:01:12Z', purpose='main', service_tier='priority', output=70)]
    timing = [TimingSample('main', 'omp', 's1', 'known', us('2026-10-01T00:00:10Z'), us('2026-10-01T00:00:15Z'), 100, kind='model'),
              TimingSample('turn', 'codex', 's1', 'known', us('2026-10-01T00:01:09Z'), us('2026-10-01T00:01:15Z'), 100)]
    query = database(tmp_path, records, timing)
    assert query.analytics(request(filters={'purpose': ['compaction']}))['summary']['tps'] == []
    main = query.analytics(request(filters={'harness': ['omp'], 'purpose': ['']}))['summary']['tps']
    assert main[0]['output'] == 100
    assert query.analytics(request(filters={'service_tier': ['priority']}))['summary']['tps'] == []
    turn = query.analytics(request(filters={'harness': ['codex'], 'purpose': ['main']}))['summary']['tps']
    assert turn[0]['output'] == 100
    assert turn[0]['samples'] == 1


def test_price_model_resolution_is_reused_including_unknown_models(tmp_path, monkeypatch):
    import codex_usage.query as module
    lookups = []
    original = module._lookup_hit
    def counting(prices, model):
        lookups.append(model)
        return original(prices, model)
    monkeypatch.setattr(module, '_lookup_hit', counting)
    query = database(tmp_path, [event(str(i), '2026-10-01T00:00:00Z', model='missing' if i % 2 else 'known') for i in range(50)])
    first = query.analytics(request())
    assert lookups == ['known', 'missing']
    assert first == query.analytics(request())
    assert lookups == ['known', 'missing']
