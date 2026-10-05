// Development-only synthetic records. This module is never a production fallback.
import type { Analysis, Query, Values, FilterKey, Dimension } from "./types";
const tools = ["Codex", "Claude Code", "OMP", "DSH"];
const models = [
    "gpt-5.4",
    "claude-opus-4.6",
    "claude-sonnet-4.6",
    "gpt-5.4-mini",
    "gemini-3.1-pro",
    "unpriced-preview",
];
const blank = (): Values => ({
    cost: 0,
    tokens: 0,
    calls: 0,
    cache_rate: null,
    cost_per_call: null,
    cost_per_million: null,
    input: 0,
    output: 0,
    cache_read: 0,
    sessions: 0,
    unpriced: 0,
});
function sum(rows: Values[]): Values {
    const v = blank();
    for (const r of rows) {
        v.cost = (v.cost ?? 0) + (r.cost ?? 0);
        v.tokens += r.tokens;
        v.calls += r.calls;
        v.input += r.input;
        v.output += r.output;
        v.cache_read += r.cache_read;
        v.unpriced += r.unpriced;
        v.sessions += r.sessions;
    }
    if (v.calls && v.unpriced === v.calls) v.cost = null;
    v.cache_rate = v.input ? v.cache_read / v.input : null;
    v.cost_per_call = v.calls && v.cost != null ? v.cost / v.calls : null;
    v.cost_per_million =
        v.tokens && v.cost != null ? (v.cost / v.tokens) * 1e6 : null;
    return v;
}
export function fixture(q: Query): Analysis {
    const step =
        q.bucket === "hour"
            ? 3600000
            : q.bucket === "week"
              ? 604800000
              : 86400000;
    const start = Date.parse(q.since),
        end = Date.parse(q.until);
    const size = Math.min(120, Math.max(1, Math.ceil((end - start) / step)));
    const records = Array.from({ length: size }, (_, day) =>
        tools.flatMap((h, t) =>
            models.map((m, i) => {
                const strength =
                    (Math.sin(day * 0.7 + t) + 1.4) *
                    (t === 0 ? 4 : t === 1 ? 2 : 1);
                const calls = Math.max(
                    0,
                    Math.floor(strength * (i === t ? 9 : 2)),
                );
                const input = calls * (3000 + i * 710);
                const output = calls * (450 + i * 83);
                const cache_read = Math.floor(input * (0.4 + t * 0.1));
                const cost =
                    i === 5
                        ? null
                        : (input * 0.000002 + output * 0.000008) *
                          (1 + (day / size) * 0.2);
                const v = {
                    ...blank(),
                    calls,
                    input,
                    output,
                    cache_read,
                    tokens: input + output,
                    cost,
                    unpriced: i === 5 ? calls : 0,
                    sessions: calls ? 1 : 0,
                };
                return {
                    harness: h,
                    model: m,
                    project: [
                        "codex-usage",
                        "weihub",
                        "new-api",
                        "chuangxin-trade",
                    ][i % 4],
                    provider: t % 2 ? "Anthropic" : "OpenAI",
                    purpose: i === 4 ? "辅助调用" : "主会话",
                    agent_type: i % 2 ? "subagent" : "main",
                    service_tier: i === 0 ? "fast" : "standard",
                    session: `${h}:session-${day}-${i}`,
                    values: sum([v]),
                };
            }),
        ),
    ).flat();
    const included = records.filter((r) =>
        (Object.keys(q.filters) as FilterKey[]).every(
            (k) => !q.filters[k]?.length || q.filters[k]!.includes(r[k]),
        ),
    );
    const keys = [...new Set(included.map((r) => r[q.dimension]))];
    const members = keys.map((key) => {
        const values = sum(
            included.filter((r) => r[q.dimension] === key).map((r) => r.values),
        );
        const previous = sum([
            {
                ...values,
                cost: values.cost == null ? null : values.cost * 0.74,
                calls: Math.floor(values.calls * 0.82),
                tokens: Math.floor(values.tokens * 0.83),
                input: Math.floor(values.input * 0.83),
                output: Math.floor(values.output * 0.83),
                cache_read: Math.floor(values.cache_read * 0.72),
            },
        ]);
        return {
            key,
            label: key,
            values,
            previous,
            delta:
                values.cost == null ? null : values.cost - (previous.cost ?? 0),
        };
    });
    const eachDay = tools.length * models.length;
    const trend: Analysis["trend"] = Array.from({ length: size }, (_, d) => {
        const raw = records
            .slice(d * eachDay, (d + 1) * eachDay)
            .filter((r) =>
                (Object.keys(q.filters) as FilterKey[]).every(
                    (k) =>
                        !q.filters[k]?.length || q.filters[k]!.includes(r[k]),
                ),
            );
        return {
            start: new Date(start + (d * (end - start)) / size).toISOString(),
            end: new Date(
                start + ((d + 1) * (end - start)) / size,
            ).toISOString(),
            total: sum(raw.map((r) => r.values)),
            members: Object.fromEntries(
                keys.map((k) => [
                    k,
                    sum(
                        raw
                            .filter((r) => r[q.dimension] === k)
                            .map((r) => r.values),
                    ),
                ]),
            ),
        };
    });
    const ranked = [...members].sort(
        (a, b) => (b.values[q.metric] ?? -1) - (a.values[q.metric] ?? -1),
    );
    const selected = q.members?.length
        ? q.members
        : ranked.slice(0, 5).map((m) => m.key);
    const series = [
        ...selected.map((key) => ({ key, label: key })),
        { key: "__other__", label: "其他" },
    ];
    for (const point of trend) {
        const other = sum(
            Object.entries(point.members)
                .filter(([k]) => !selected.includes(k))
                .map(([, v]) => v),
        );
        point.members = Object.fromEntries([
            ...selected.map((k) => [k, point.members[k] ?? blank()]),
            ["__other__", other],
        ]);
    }
    for (const point of trend) {
        const total = point.total[q.metric];
        point.shares = Object.fromEntries(
            Object.entries(point.members).map(([key, v]) => [
                key,
                total && v[q.metric] != null ? v[q.metric]! / total : null,
            ]),
        );
    }
    const facets = Object.fromEntries(
        (
            [
                "harness",
                "model",
                "project",
                "provider",
                "purpose",
                "agent_type",
                "service_tier",
                "session",
            ] as FilterKey[]
        ).map((k) => [
            k,
            [...new Set(records.map((r) => r[k]))].map((key) => ({
                key,
                label: key,
            })),
        ]),
    ) as Analysis["facets"];
    return {
        query: q,
        snapshot_id: "synthetic-development",
        summary: sum(members.map((r) => r.values)),
        previous_summary: sum(members.map((r) => r.previous)),
        members,
        series,
        trend,
        facets,
        coverage: {
            updated_at: new Date().toISOString(),
            warnings: [],
            sources: tools.map((h) => ({
                harness: h,
                state: "ready",
                files: 42,
                events: included.filter((r) => r.harness === h).length,
                updated_at: new Date().toISOString(),
                warnings: h === "DSH" ? ["示例：部分记录缺少 provider"] : [],
            })),
        },
        pricing: { label: "合成估值 · 开发数据" },
    };
}
