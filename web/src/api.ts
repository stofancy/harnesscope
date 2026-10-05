import type {
    Analysis,
    Delta,
    Dimension,
    FilterKey,
    Metric,
    Query,
    SessionDetail,
    Source,
    Timing,
    Values,
    GlobalQuery,
    PanelConfig,
    PanelId,
    TurnsAnalysis,
    TurnRow,
    TurnDetail,
    UsageAnalysis,
    UsageView,
    UsageDrill,
    UsageRow,
    DisplayLabels,
} from "./types";
import { displayNames } from "./names";
export const demo =
    import.meta.env?.DEV &&
    new URLSearchParams(location.search).get("demo") === "1";
const metricNames: Record<Metric, string> = {
    input: "input",
    output: "output",
    cache_read: "cache_read",
    cache_write: "cache_write",
    tpm: "tpm",
    rpm: "rpm",
    throughput_tps: "throughput_tps",
    rps: "rps",
    timed_tps: "output",
    cost: "cost_usd",
    tokens: "tokens",
    calls: "calls",
    cost_per_call: "cost_per_call",
    cost_per_million: "cost_per_mtok",
    cache_rate: "cache_hit_rate",
};
const toolLabels: Record<string, string> = {
    codex: "Codex",
    claude: "Claude Code",
    omp: "OMP",
    dsh: "DSH",
};
const harnessContext = (q: GlobalQuery) =>
    q.filters.harness?.length === 1 ? q.filters.harness[0] : undefined;
const label = (s: string, dimension?: string, harness?: string) => {
    if (dimension === "service_tier") {
        const mode = s.toLowerCase();
        if (mode === "unknown" || !mode) return "未记录";
        if (harness === "codex")
            return (
                (
                    {
                        priority: "Fast",
                        fast: "Fast",
                        default: "标准",
                        standard: "标准",
                    } as Record<string, string>
                )[mode] ?? s
            );
        if (harness) return s;
        return (
            (
                {
                    priority: "Fast（Codex） / priority",
                    fast: "Fast（Codex） / fast",
                    default: "标准",
                    standard: "标准",
                } as Record<string, string>
            )[mode] ?? s
        );
    }
    return s === "Other"
        ? "其他"
        : s === "Unknown" || !s
          ? "未知归属"
          : (toolLabels[s] ?? s);
};
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!response.ok) {
        let reason = `请求失败 (${response.status})`;
        try {
            const body = await response.json();
            reason = body.error ?? body.detail ?? reason;
        } catch {
            /* HTTP status is enough */
        }
        throw new Error(
            typeof reason === "string" ? reason : JSON.stringify(reason),
        );
    }
    return response.json();
}
export type RawMetrics = {
    tpm?: number | null;
    rpm?: number | null;
    throughput_tps?: number | null;
    rps?: number | null;
    seconds?: number;
    input_net?: number | null;
    cache_write?: number | null;
    cost_usd: number;
    cost_complete: boolean;
    cache_write_complete?: boolean;
    calls: number;
    priced_calls: number;
    unpriced_calls: number;
    tokens: number;
    input: number;
    output: number;
    cache_read: number;
    cache_hit_rate: number | null;
    cost_per_call: number | null;
    cost_per_mtok: number | null;
    sessions: number;
    tps: Timing[];
};
type RawMember = {
    key: string;
    label: string;
    dimensions: Partial<Record<Dimension, string>>;
    metrics: RawMetrics;
};
type RawSource = {
    harness: string;
    state: string;
    files: number;
    events: number;
    warnings: number;
    errors?: number;
    error?: string;
    last_scan_us?: number;
};
type RawStatus = {
    snapshot_id: number;
    refreshing: boolean;
    last_refresh_error: string | null;
    progress: {
        files_done: number;
        files_total: number;
        current_harness: string | null;
        events_added: number;
    };
    sources: RawSource[];
};
export type Status = {
    sources: Source[];
    scanning: boolean;
    error: string | null;
    progress: RawStatus["progress"];
    updated_at: string | null;
    snapshot_id: string;
};
export type RawAnalysis = {
    labels?: DisplayLabels;
    snapshot: { id: string };
    query?: { bucket_resolved?: Query["bucket"] };
    summary: RawMetrics;
    trend: {
        timing_members?: Analysis["timing_members"];
        members: { key: string; label: string }[];
        buckets: {
            start: string;
            end: string;
            window_start?: string;
            window_end?: string;
            seconds?: number;
            timed_tps?: Analysis["trend"][number]["timing"];
            metrics: RawMetrics;
            value: number | null;
            series: {
                key: string;
                metrics: RawMetrics;
                value: number | null;
                share: number | null;
            }[];
        }[];
    };
    breakdown: RawMember[];
    comparison: {
        start?: string;
        end?: string;
        summary: RawMetrics;
        delta: Record<string, Delta>;
        members: {
            key: string;
            current: RawMetrics;
            previous: RawMetrics;
            delta: Record<string, Delta>;
        }[];
    };
    facets: Record<FilterKey, string[]>;
    coverage: { sources: RawSource[]; missing_price_models: string[] };
};
export function normalizeMetrics(m: RawMetrics): Values {
    return {
        tpm: m.tpm ?? null,
        rpm: m.rpm ?? null,
        throughput_tps: m.throughput_tps ?? null,
        rps: m.rps ?? null,
        seconds: m.seconds,
        input_net: m.input_net ?? null,
        cache_write: m.cache_write ?? null,
        cost: m.calls > 0 && m.priced_calls === 0 ? null : m.cost_usd,
        tokens: m.tokens,
        calls: m.calls,
        cache_rate: m.cache_hit_rate,
        cost_per_call: m.cost_per_call,
        cost_per_million: m.cost_per_mtok,
        input: m.input,
        output: m.output,
        cache_read: m.cache_read,
        sessions: m.sessions,
        unpriced: m.unpriced_calls,
        cost_complete: m.cost_complete,
        input_complete: m.cache_write_complete,
        tps: m.tps ?? [],
    };
}
const changes = (d: Record<string, Delta>) =>
    Object.fromEntries(
        Object.entries(metricNames).map(([ui, api]) => [ui, d[api]]),
    ) as Partial<Record<Metric, Delta>>;
function source(s: RawSource): Source {
    return {
        harness: toolLabels[s.harness] ?? s.harness,
        state:
            s.state === "not_found"
                ? "missing"
                : s.state === "partial"
                  ? "partial"
                  : s.state === "error" || (s.errors ?? 0) > 0
                    ? "error"
                    : s.state === "scanning"
                      ? "scanning"
                      : "ready",
        files: s.files,
        events: s.events ?? 0,
        updated_at: s.last_scan_us
            ? new Date(s.last_scan_us / 1000).toISOString()
            : null,
        warnings: [
            ...(s.warnings ? [`${s.warnings} 条解析提示`] : []),
            ...(s.error ? [s.error] : []),
            ...((s.errors ?? 0) > 0 ? [`${s.errors} 个文件读取失败`] : []),
        ],
    };
}
export function normalize(raw: RawAnalysis, q: Query, scan?: Status): Analysis {
    const previous = new Map(raw.comparison.members.map((m) => [m.key, m]));
    const names = displayNames(raw.labels, q.timezone);
    const memberLabel = (m: { label: string; dimensions?: Record<string, string> }) =>
        q.dimension === "project"
            ? names.project(m.dimensions?.project ?? m.label)
            : q.dimension === "session"
              ? names.session(m.dimensions?.harness ?? harnessContext(q) ?? "", m.dimensions?.session ?? m.label)
              : label(m.label, q.dimension, m.dimensions?.harness ?? harnessContext(q));
    return {
        labels: raw.labels,
        snapshot_id: String(raw.snapshot.id),
        bucket_resolved: raw.query?.bucket_resolved ?? q.bucket,
        timing_members: raw.trend.timing_members ?? [],
        query: q,
        summary: normalizeMetrics(raw.summary),
        previous_summary: normalizeMetrics(raw.comparison.summary),
        comparison_range: raw.comparison.start && raw.comparison.end
            ? { since: raw.comparison.start, until: raw.comparison.end }
            : undefined,
        changes: changes(raw.comparison.delta),
        knownCostChange: raw.comparison.delta.cost_usd_known,
        members: raw.breakdown.map((m) => {
            const cmp = previous.get(m.key);
            return {
                key: m.key,
                label: memberLabel(m),
                tooltip: q.dimension === "session"
                    ? names.sessionTooltip(m.dimensions.harness ?? "", m.dimensions.session ?? m.label)
                    : q.dimension === "project" ? m.dimensions.project ?? m.key : m.label,
                values: normalizeMetrics(m.metrics),
                previous: normalizeMetrics(cmp?.previous ?? m.metrics),
                delta: cmp?.delta.cost_usd?.absolute ?? null,
                changes: cmp ? changes(cmp.delta) : {},
                knownCostChange: cmp?.delta.cost_usd_known,
                harness: m.dimensions.harness,
                session_id: m.dimensions.session,
                subtitle:
                    q.dimension === "session"
                        ? (toolLabels[m.dimensions.harness ?? ""] ??
                          m.dimensions.harness)
                        : undefined,
            };
        }),
        series: raw.trend.members.map((m) => ({
            key: m.key,
            label: memberLabel({ ...m, dimensions: raw.breakdown.find((b) => b.key === m.key)?.dimensions }),
        })),
        trend: raw.trend.buckets.map((p) => ({
            start: p.start,
            end: p.end,
            window_start: p.window_start,
            window_end: p.window_end,
            seconds: p.seconds,
            timing: p.timed_tps ?? [],
            total: normalizeMetrics(p.metrics),
            shares: Object.fromEntries(p.series.map((s) => [s.key, s.share])),
            members: Object.fromEntries(
                p.series.map((s) => [s.key, normalizeMetrics(s.metrics)]),
            ),
        })),
        facets: Object.fromEntries(
            Object.entries(raw.facets).map(([k, values]) => [
                k,
                [...new Set([...values, ...(q.filters[k as FilterKey] ?? [])])].map((v) => ({
                    key: v,
                    label: k === "project" ? names.project(v)
                        : k === "session" ? names.facetSession(v, harnessContext(q))
                        : label(v, k, harnessContext(q)),
                    tooltip: v,
                })),
            ]),
        ) as Analysis["facets"],
        coverage: {
            sources:
                scan && scan.snapshot_id === String(raw.snapshot.id)
                    ? scan.sources
                    : raw.coverage.sources.map(source),
            warnings: raw.coverage.missing_price_models.length
                ? [
                      `有 ${raw.coverage.missing_price_models.length} 个模型缺价，费用展示已知估算小计；完整费用变化与单位效率未知。`,
                  ]
                : [],
            updated_at:
                scan?.snapshot_id === String(raw.snapshot.id)
                    ? scan.updated_at
                    : null,
        },
        pricing: { label: "公开/自定义价目估算 · USD" },
    };
}
export async function analyze(
    q: Query,
    signal: AbortSignal,
): Promise<Analysis> {
    if (demo) {
        const { fixture } = await import("./fixture");
        return fixture(q);
    }
    const p = new URLSearchParams({
        start: q.since,
        end: q.until,
        timezone: q.timezone,
        bucket: q.bucket,
        group_by: q.dimension === "session" ? "harness,session" : q.dimension,
        metric: metricNames[q.metric],
    });
    for (const [key, values] of Object.entries(q.filters))
        for (const v of values ?? []) p.append(key, v);
    for (const member of q.members ?? []) p.append("member", member);
    const raw = await request<RawAnalysis>(`/api/analytics?${p}`, { signal });
    return normalize(raw, q);
}
export async function refresh() {
    if (demo) return { scanning: false };
    const raw = await request<{ refreshing: boolean }>("/api/refresh", {
        method: "POST",
        body: "{}",
    });
    return { scanning: raw.refreshing };
}
let statusPending: Promise<Status> | null = null;
export function status(signal?: AbortSignal): Promise<Status> {
    if (!statusPending) {
        statusPending = request<RawStatus>("/api/status")
            .then((raw) => {
                const latest = Math.max(
                    0,
                    ...raw.sources.map((s) => s.last_scan_us ?? 0),
                );
                return {
                    sources: raw.sources.map(source),
                    scanning: raw.refreshing,
                    error: raw.last_refresh_error,
                    progress: raw.progress,
                    updated_at: latest
                        ? new Date(latest / 1000).toISOString()
                        : null,
                    snapshot_id: String(raw.snapshot_id),
                };
            })
            .finally(() => {
                statusPending = null;
            });
    }
    return statusPending.then((result) => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return result;
    });
}
export async function sessionDetail(
    harness: string,
    id: string,
    q: Query,
): Promise<SessionDetail> {
    type Raw = {
        labels?: DisplayLabels;
        snapshot: { id: string };
        session: { harness: string; session_id: string; children: string[] };
        summary: RawMetrics;
        events: {
            timestamp_us: number;
            model: string;
            purpose: string | null;
            project: string | null;
            parent_session_id: string | null;
            cost_usd: number | null;
            input_net: number;
            cache_read: number;
            cache_write: number | null;
            output: number;
        }[];
    };
    const p = new URLSearchParams({
        start: q.since,
        end: q.until,
        timezone: q.timezone,
    });
    for (const [k, values] of Object.entries(q.filters))
        for (const v of values ?? []) p.append(k, v);
    const raw = await request<Raw>(
        `/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}?${p}`,
    );
    return {
        harness,
        labels: raw.labels,
        session_id: id,
        project: raw.events[0]?.project ?? null,
        parent_session_id: raw.events[0]?.parent_session_id ?? null,
        summary: normalizeMetrics(raw.summary),
        snapshot_id: String(raw.snapshot.id),
        calls: raw.events.map((e) => ({
            timestamp: new Date(e.timestamp_us / 1000).toISOString(),
            model: e.model,
            purpose: e.purpose,
            values: {
                cost: e.cost_usd,
                tokens:
                    e.input_net +
                    e.cache_read +
                    (e.cache_write ?? 0) +
                    e.output,
                calls: 1,
                cache_rate: null,
                cost_per_call: null,
                cost_per_million: null,
                input: e.input_net + e.cache_read + (e.cache_write ?? 0),
                output: e.output,
                cache_read: e.cache_read,
                sessions: 1,
                unpriced: e.cost_usd == null ? 1 : 0,
            },
        })),
        children: raw.session.children.map((sid) => ({
            harness,
            session_id: sid,
        })),
    };
}
function globalParams(q: GlobalQuery) {
    const p = new URLSearchParams({
        start: q.since,
        end: q.until,
        timezone: q.timezone,
        bucket: q.bucket,
    });
    for (const [k, values] of Object.entries(q.filters))
        for (const v of values ?? []) p.append(k, v);
    return p;
}
type RawTurns = {
    labels?: DisplayLabels;
    snapshot: { id: string };
    query: { bucket_resolved: Query["bucket"] };
    summary: Omit<TurnsAnalysis["summary"], "metrics"> & {
        metrics: RawMetrics;
    };
    trend: {
        buckets: (Omit<TurnsAnalysis["trend"][number], "metrics"> & {
            metrics: RawMetrics;
        })[];
    };
    tools: TurnsAnalysis["tools"];
    rows: (Omit<TurnRow, "window_metrics" | "full_metrics"> & {
        window_metrics: RawMetrics;
        full_metrics: RawMetrics | null;
    })[];
    total: number;
    offset: number;
    limit: number;
    coverage: TurnsAnalysis["coverage"];
};
function normalizeTurn(
    row: Omit<TurnRow, "window_metrics" | "full_metrics"> & {
        window_metrics: RawMetrics;
        full_metrics: RawMetrics | null;
    },
): TurnRow {
    return {
        ...row,
        window_metrics: normalizeMetrics(row.window_metrics),
        full_metrics: row.full_metrics
            ? normalizeMetrics(row.full_metrics)
            : null,
    };
}
export async function turns(
    q: GlobalQuery,
    offset: number,
    signal: AbortSignal,
    sorting: { sort: string; order: "asc" | "desc" } = {
        sort: "start",
        order: "desc",
    },
    includeRows = true,
): Promise<TurnsAnalysis> {
    if (demo) {
        const { fixture } = await import("./fixture");
        const sample = fixture({
            ...q,
            dimension: "harness",
            metric: "tokens",
        });
        const metrics: Values = {
            cost: 0,
            tokens: 0,
            calls: 0,
            input: 0,
            output: 0,
            cache_read: 0,
            cache_rate: null,
            cost_per_call: null,
            cost_per_million: null,
            sessions: 0,
            unpriced: 0,
        };
        return {
            snapshot_id: sample.snapshot_id,
            query: q,
            bucket_resolved: q.bucket,
            summary: {
                turns: 0,
                status_counts: {},
                metrics,
                tool_calls_known: 0,
                tool_calls: null,
                tools_per_turn: null,
                duration_p50: null,
                duration_p95: null,
                duration_samples: 0,
                full_turns: 0,
                per_turn: {
                    samples: 0,
                    calls: null,
                    tokens: null,
                    cost_usd: null,
                },
            },
            trend: [],
            tools: {
                coverage: "unknown",
                scope: "selected_turns",
                status_counts: {},
                rows: [],
            },
            rows: [],
            total: 0,
            offset: 0,
            limit: 20,
            coverage: {
                boundary_quality: {},
                tool_coverage: {},
                truncated_turns: 0,
                unassigned_calls: 0,
                usage_scope: "all_recorded_calls",
            },
        };
    }
    const p = globalParams(q);
    p.set("offset", String(offset));
    p.set("limit", "20");
    p.set("sort", sorting.sort);
    p.set("order", sorting.order);
    if (!includeRows) p.set("include_rows", "false");
    const raw = await request<RawTurns>(`/api/turns?${p}`, { signal });
    return {
        labels: raw.labels,
        snapshot_id: String(raw.snapshot.id),
        query: q,
        bucket_resolved: raw.query.bucket_resolved,
        summary: {
            ...raw.summary,
            metrics: normalizeMetrics(raw.summary.metrics),
        },
        trend: raw.trend.buckets.map((p) => ({
            ...p,
            metrics: normalizeMetrics(p.metrics),
        })),
        tools: raw.tools,
        rows: raw.rows.map(normalizeTurn),
        total: raw.total,
        offset: raw.offset,
        limit: raw.limit,
        coverage: raw.coverage,
    };
}
export async function turnDetail(
    q: GlobalQuery,
    identity: { harness: string; session_id: string; turn_id: string },
    signal?: AbortSignal,
): Promise<TurnDetail> {
    const p = globalParams(q);
    p.set("harness", identity.harness);
    p.set("session_id", identity.session_id);
    p.set("turn_id", identity.turn_id);
    type Raw = Omit<
        TurnDetail,
        "snapshot_id" | "window_metrics" | "recorded_metrics"
    > & {
        snapshot: { id: string };
        window_metrics: RawMetrics;
        recorded_metrics: RawMetrics;
    };
    const raw = await request<Raw>(`/api/turns/detail?${p}`, { signal });
    return {
        ...raw,
        snapshot_id: String(raw.snapshot.id),
        window_metrics: normalizeMetrics(raw.window_metrics),
        recorded_metrics: normalizeMetrics(raw.recorded_metrics),
    };
}
export type Dashboard = {
    global: GlobalQuery;
    panels: Record<PanelId, Analysis>;
    turns: TurnsAnalysis;
    snapshot_id: string;
};
export async function dashboard(
    global: GlobalQuery,
    configs: Record<PanelId, PanelConfig>,
    signal: AbortSignal,
): Promise<Dashboard> {
    const ids = Object.keys(configs) as PanelId[];
    for (let attempt = 0; attempt < 4; attempt++) {
        const [analyses, turnsResult] = await Promise.all([
            Promise.all(
                ids.map((id) => analyze({ ...global, ...configs[id] }, signal)),
            ),
            turns(global, 0, signal, undefined, false),
        ]);
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const snapshot = analyses[0].snapshot_id;
        if ([...analyses, turnsResult].every((r) => r.snapshot_id === snapshot))
            return {
                global,
                panels: Object.fromEntries(
                    ids.map((id, i) => [id, analyses[i]]),
                ) as Record<PanelId, Analysis>,
                turns: turnsResult,
                snapshot_id: snapshot,
            };
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("数据仍在更新，请稍后刷新。");
}

export async function usage(
    q: GlobalQuery,
    view: UsageView,
    drill: UsageDrill | null,
    signal?: AbortSignal,
): Promise<UsageAnalysis> {
    const p = globalParams(q);
    p.set("group", view.group);
    p.set("sort", view.sort);
    p.set("order", view.order);
    p.set("offset", String(view.offset));
    p.set("limit", String(view.limit));
    if (drill) {
        const i = drill.identity;
        if (i.harness != null) p.set("harness", i.harness);
        if (i.session_id != null) p.set("session", i.session_id);
        if ("turn_id" in i) p.set("turn_id", i.turn_id ?? "");
        if (i.model != null) p.set("model", i.model);
    }
    type Raw = Omit<
        UsageAnalysis,
        "snapshot_id" | "summary" | "rows" | "facets"
    > & {
        snapshot: { id: string };
        summary: RawMetrics;
        rows: (Omit<UsageRow, "metrics"> & { metrics: RawMetrics })[];
        facets: Record<FilterKey, string[]>;
    };
    const r = await request<Raw>(`/api/usage?${p}`, { signal });
    const names = displayNames(r.labels, q.timezone);
    return {
        ...r,
        query: q,
        snapshot_id: String(r.snapshot.id),
        summary: normalizeMetrics(r.summary),
        rows: r.rows.map((row) => ({
            ...row,
            metrics: normalizeMetrics(row.metrics),
        })),
        facets: Object.fromEntries(
            Object.entries(r.facets).map(([k, vs]) => [
                k,
                [...new Set([...vs, ...(q.filters[k as FilterKey] ?? [])])].map((v) => ({
                    key: v,
                    label: k === "project" ? names.project(v)
                        : k === "session" ? names.facetSession(v, harnessContext(q))
                        : label(v, k, harnessContext(q)),
                    tooltip: v,
                    count: 0,
                })),
            ]),
        ) as unknown as Analysis["facets"],
    };
}
