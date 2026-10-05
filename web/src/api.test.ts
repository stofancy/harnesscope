import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalize, type RawAnalysis, type RawMetrics } from "./api.ts";
import type { Query } from "./types.ts";
const q: Query = {
    since: "2026-10-01T00:00:00Z",
    until: "2026-10-02T00:00:00Z",
    timezone: "Asia/Singapore",
    bucket: "day",
    dimension: "harness",
    metric: "cost",
    filters: {},
};
const metrics = (extra: Partial<RawMetrics> = {}): RawMetrics => ({
    cost_usd: 2,
    cost_complete: true,
    calls: 1,
    priced_calls: 1,
    unpriced_calls: 0,
    tokens: 1000,
    input: 900,
    output: 100,
    cache_read: 300,
    cache_hit_rate: 1 / 3,
    cost_per_call: 2,
    cost_per_mtok: 2000,
    sessions: 1,
    tps: [],
    ...extra,
});
const delta = { absolute: null, relative: null };
function response(): RawAnalysis {
    return {
        snapshot: { id: "4" },
        summary: metrics({
            calls: 2,
            unpriced_calls: 1,
            cost_complete: false,
            cost_per_call: null,
            cost_per_mtok: null,
        }),
        comparison: {
            summary: metrics(),
            delta: {
                cost_usd: delta,
                cost_usd_known: { absolute: 1, relative: 1 },
            },
            members: [
                {
                    key: "codex",
                    current: metrics(),
                    previous: metrics(),
                    delta: { cost_usd: delta },
                },
            ],
        },
        breakdown: [
            {
                key: "codex",
                label: "codex",
                dimensions: { harness: "codex" },
                metrics: metrics(),
            },
        ],
        trend: {
            members: [
                { key: "codex", label: "codex" },
                { key: "__other__", label: "Other" },
            ],
            buckets: [
                {
                    start: q.since,
                    end: q.until,
                    metrics: metrics({
                        cost_complete: false,
                        unpriced_calls: 1,
                    }),
                    value: 2,
                    series: [
                        {
                            key: "codex",
                            metrics: metrics(),
                            value: 2,
                            share: 1,
                        },
                        {
                            key: "__other__",
                            metrics: metrics({
                                calls: 1,
                                priced_calls: 0,
                                cost_usd: 0,
                                cost_complete: false,
                            }),
                            value: null,
                            share: null,
                        },
                    ],
                },
            ],
        },
        facets: {
            harness: ["codex"],
            model: [],
            project: [],
            provider: [],
            purpose: [],
            agent_type: [],
            service_tier: [],
            session: [],
        },
        coverage: { sources: [], missing_price_models: ["unknown"] },
    };
}
test("partial known cost stays visible, complete change and efficiency remain unknown", () => {
    const v = normalize(response(), q);
    assert.equal(v.summary.cost, 2);
    assert.equal(v.summary.cost_complete, false);
    assert.equal(v.summary.cost_per_call, null);
    assert.equal(v.changes?.cost?.absolute, null);
    assert.equal(v.knownCostChange?.absolute, 1);
    assert.equal(v.trend[0].members.__other__.cost, null);
    assert.equal(v.series?.[1].label, "其他");
    assert.equal(v.trend[0].shares?.codex, 1);
});
test("empty bucket zero differs from wholly unpriced bucket", () => {
    const raw = response();
    raw.trend.buckets[0].series[0].metrics = metrics({
        calls: 0,
        priced_calls: 0,
        cost_usd: 0,
    });
    const v = normalize(raw, q);
    assert.equal(v.trend[0].members.codex.cost, 0);
    assert.equal(v.trend[0].members.__other__.cost, null);
});
test("session key retains harness identity for detail requests", () => {
    const raw = response();
    raw.breakdown[0] = {
        key: '["omp","same"]',
        label: "omp / same",
        dimensions: { harness: "omp", session: "same" },
        metrics: metrics(),
    };
    const v = normalize(raw, { ...q, dimension: "session" });
    assert.equal(v.members[0].harness, "omp");
    assert.equal(v.members[0].session_id, "same");
});
