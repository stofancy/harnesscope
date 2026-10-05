import { resolveTime, type TimeSpec } from "./time";
import type {
    Dimension,
    GlobalQuery,
    Metric,
    PanelConfig,
    PanelId,
    ChartKind,
} from "./types";
export type TurnView = {
    metric: string;
    chart: ChartKind;
    sort: string;
    order: "asc" | "desc";
};
export type Preferences = {
    global: GlobalQuery;
    timeSpec: TimeSpec;
    autoSeconds: number;
    panels: Record<PanelId, PanelConfig>;
    ledger: { dimension: Dimension; metric: Metric };
    detailView: "summary" | "turns";
    turnView: TurnView;
    history: { since: string; until: string; timeSpec: TimeSpec }[];
};
const storageKey = "usage-dashboard.preferences.v2";
const dimensions = [
    "harness",
    "model",
    "project",
    "provider",
    "purpose",
    "agent_type",
    "service_tier",
    "session",
];
const metrics = [
    "cost",
    "tokens",
    "calls",
    "cost_per_call",
    "cost_per_million",
    "cache_rate",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "tpm",
    "rpm",
    "throughput_tps",
    "rps",
    "timed_tps",
];
const panelMetrics = {
    consumption: [
        "cost",
        "tokens",
        "input",
        "output",
        "calls",
        "cost_per_call",
        "cost_per_million",
    ],
    rate: ["tpm", "rpm", "throughput_tps", "rps"],
    cache: ["cache_rate", "cache_read", "cache_write"],
    speed: ["timed_tps", "throughput_tps", "rps"],
};
const buckets = [
    "auto",
    "second",
    "10second",
    "minute",
    "5minute",
    "15minute",
    "hour",
    "day",
    "week",
    "month",
];
const kinds = ["area", "line", "bar"];
const strings = (v: unknown, limit = 100): v is string[] =>
    Array.isArray(v) &&
    v.length <= limit &&
    v.every((x) => typeof x === "string" && x.length <= 4096);
const windowValid = (q: { since?: string; until?: string }) =>
    typeof q.since === "string" &&
    typeof q.until === "string" &&
    Number.isFinite(Date.parse(q.since)) &&
    Date.parse(q.until) > Date.parse(q.since);
export function defaults(): Preferences {
    const now = new Date();
    return {
        global: {
            since: new Date(now.getTime() - 7 * 86400000).toISOString(),
            until: now.toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            bucket: "auto",
            filters: {},
        },
        timeSpec: { start: "-7d", end: "now" },
        autoSeconds: 0,
        panels: {
            consumption: {
                dimension: "model",
                metric: "cost",
                chart: "area",
                share: false,
                members: [],
            },
            rate: {
                dimension: "harness",
                metric: "tpm",
                chart: "line",
                share: false,
                members: [],
            },
            cache: {
                dimension: "model",
                metric: "cache_rate",
                chart: "line",
                share: false,
                members: [],
            },
            speed: {
                dimension: "harness",
                metric: "timed_tps",
                chart: "line",
                share: false,
                members: [],
            },
        },
        ledger: { dimension: "model", metric: "cost" },
        detailView: "summary",
        turnView: {
            metric: "tokens",
            chart: "bar",
            sort: "start",
            order: "desc",
        },
        history: [],
    };
}
export function readPreferences(): Preferences {
    const fallback = defaults();
    try {
        const stored = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        if (!stored || stored.version !== 2) return fallback;
        const p: Preferences = stored.preferences;
        if (
            !p ||
            !windowValid(p.global) ||
            typeof p.global.timezone !== "string" ||
            !buckets.includes(p.global.bucket) ||
            !p.timeSpec ||
            ![0, 15, 30, 60, 300].includes(p.autoSeconds) ||
            !p.global.filters ||
            !dimensions.every(
                (d) =>
                    !p.global.filters[d as Dimension] ||
                    strings(p.global.filters[d as Dimension]),
            )
        )
            return fallback;
        if (Object.keys(p.global.filters).some((k) => !dimensions.includes(k)))
            return fallback;
        new Intl.DateTimeFormat("en-US", { timeZone: p.global.timezone });
        for (const id of Object.keys(fallback.panels) as PanelId[]) {
            const c = p.panels?.[id];
            if (
                !c ||
                !dimensions.includes(c.dimension) ||
                !panelMetrics[id].includes(c.metric) ||
                !kinds.includes(c.chart) ||
                typeof c.share !== "boolean" ||
                (c.share &&
                    [
                        "cost_per_call",
                        "cost_per_million",
                        "cache_rate",
                        "tpm",
                        "rpm",
                        "throughput_tps",
                        "rps",
                        "timed_tps",
                    ].includes(c.metric)) ||
                !strings(c.members, 5)
            )
                return fallback;
        }
        if (
            !dimensions.includes(p.ledger?.dimension) ||
            !metrics.includes(p.ledger?.metric) ||
            !["summary", "turns"].includes(p.detailView)
        )
            return fallback;
        if (
            !p.turnView ||
            !kinds.includes(p.turnView.chart) ||
            ![
                "turns",
                "tokens",
                "cost",
                "calls",
                "tool_calls",
                "tool_calls_known",
                "duration_p50",
                "duration_p95",
            ].includes(p.turnView.metric) ||
            ![
                "start",
                "cost_usd",
                "tokens",
                "duration",
                "calls",
                "tool_calls",
            ].includes(p.turnView.sort) ||
            !["asc", "desc"].includes(p.turnView.order)
        )
            return fallback;
        if (
            !Array.isArray(p.history) ||
            p.history.length > 16 ||
            !p.history.every(
                (h) =>
                    windowValid(h) && h.timeSpec && !!resolveTime(h.timeSpec),
            )
        )
            return fallback;
        const resolved = resolveTime(p.timeSpec);
        if (p.timeSpec.end === "now") p.global = { ...p.global, ...resolved };
        return {
            global: {
                since: p.global.since,
                until: p.global.until,
                timezone: p.global.timezone,
                bucket: p.global.bucket,
                filters: p.global.filters,
            },
            timeSpec: { start: p.timeSpec.start, end: p.timeSpec.end },
            autoSeconds: p.autoSeconds,
            panels: Object.fromEntries(
                Object.entries(p.panels)
                    .filter(([id]) => id in fallback.panels)
                    .map(([id, c]) => [
                        id,
                        {
                            dimension: c.dimension,
                            metric: c.metric,
                            chart: c.chart,
                            share: c.share,
                            members: c.members,
                        },
                    ]),
            ) as Preferences["panels"],
            ledger: { dimension: p.ledger.dimension, metric: p.ledger.metric },
            detailView: p.detailView,
            turnView: {
                metric: p.turnView.metric,
                chart: p.turnView.chart,
                sort: p.turnView.sort,
                order: p.turnView.order,
            },
            history: p.history.map((h) => ({
                since: h.since,
                until: h.until,
                timeSpec: { start: h.timeSpec.start, end: h.timeSpec.end },
            })),
        };
    } catch {
        return fallback;
    }
}
export function savePreferences(preferences: Preferences) {
    try {
        localStorage.setItem(
            storageKey,
            JSON.stringify({ version: 2, preferences }),
        );
    } catch {
        /* A denied or full local store does not prevent analysis. */
    }
}
