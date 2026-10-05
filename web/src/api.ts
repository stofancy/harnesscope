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
} from "./types";
export const demo =
    import.meta.env?.DEV &&
    new URLSearchParams(location.search).get("demo") === "1";
const metricNames: Record<Metric, string> = {
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
const label = (s: string) =>
    s === "Other"
        ? "其他"
        : s === "Unknown" || s === ""
          ? "未知归属"
          : (toolLabels[s] ?? s);
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
    snapshot: { id: string };
    summary: RawMetrics;
    trend: {
        members: { key: string; label: string }[];
        buckets: {
            start: string;
            end: string;
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
    return {
        snapshot_id: String(raw.snapshot.id),
        query: q,
        summary: normalizeMetrics(raw.summary),
        previous_summary: normalizeMetrics(raw.comparison.summary),
        changes: changes(raw.comparison.delta),
        knownCostChange: raw.comparison.delta.cost_usd_known,
        members: raw.breakdown.map((m) => {
            const cmp = previous.get(m.key);
            return {
                key: m.key,
                label: label(m.label),
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
            label: label(m.label),
        })),
        trend: raw.trend.buckets.map((p) => ({
            start: p.start,
            end: p.end,
            total: normalizeMetrics(p.metrics),
            shares: Object.fromEntries(p.series.map((s) => [s.key, s.share])),
            members: Object.fromEntries(
                p.series.map((s) => [s.key, normalizeMetrics(s.metrics)]),
            ),
        })),
        facets: Object.fromEntries(
            Object.entries(raw.facets).map(([k, values]) => [
                k,
                values.map((v) => ({ key: v, label: label(v) })),
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
    const [raw, scan] = await Promise.all([
        request<RawAnalysis>(`/api/analytics?${p}`, { signal }),
        status(signal),
    ]);
    return normalize(raw, q, scan);
}
export async function refresh() {
    if (demo) return { scanning: false };
    const raw = await request<{ refreshing: boolean }>("/api/refresh", {
        method: "POST",
        body: "{}",
    });
    return { scanning: raw.refreshing };
}
export async function status(signal?: AbortSignal): Promise<Status> {
    const raw = await request<RawStatus>("/api/status", { signal });
    const latest = Math.max(0, ...raw.sources.map((s) => s.last_scan_us ?? 0));
    return {
        sources: raw.sources.map(source),
        scanning: raw.refreshing,
        error: raw.last_refresh_error,
        progress: raw.progress,
        updated_at: latest ? new Date(latest / 1000).toISOString() : null,
        snapshot_id: String(raw.snapshot_id),
    };
}
export async function sessionDetail(
    harness: string,
    id: string,
    q: Query,
): Promise<SessionDetail> {
    type Raw = {
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
