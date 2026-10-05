export type Dimension =
    | "harness"
    | "model"
    | "project"
    | "provider"
    | "purpose"
    | "agent_type"
    | "service_tier"
    | "session";
export type Metric =
    | "cost"
    | "tokens"
    | "calls"
    | "cost_per_call"
    | "cost_per_million"
    | "cache_rate";
export type Bucket = "hour" | "day" | "week";
export type Timing = {
    harness: string;
    kind: string;
    output: number;
    seconds: number;
    samples: number;
    tps: number | null;
};
export type Delta = { absolute: number | null; relative: number | null };
export type Values = {
    cost_complete?: boolean;
    input_complete?: boolean;
    tps?: Timing[];
    cost: number | null;
    tokens: number;
    calls: number;
    cache_rate: number | null;
    cost_per_call: number | null;
    cost_per_million: number | null;
    input: number;
    output: number;
    cache_read: number;
    sessions: number;
    unpriced: number;
};
export type Member = {
    key: string;
    label: string;
    values: Values;
    previous: Values;
    delta: number | null;
    changes?: Partial<Record<Metric, Delta>>;
    knownCostChange?: Delta;
    harness?: string;
    session_id?: string;
    subtitle?: string;
};
export type Point = {
    start: string;
    end: string;
    total: Values;
    members: Record<string, Values>;
    shares?: Record<string, number | null>;
};
export type Source = {
    harness: string;
    state: "ready" | "missing" | "error" | "partial" | "scanning";
    files: number;
    events: number;
    updated_at: string | null;
    warnings: string[];
};
export type FilterKey =
    | "harness"
    | "model"
    | "project"
    | "provider"
    | "purpose"
    | "agent_type"
    | "service_tier"
    | "session";
export type Filters = Partial<Record<FilterKey, string[]>>;
export type Query = {
    since: string;
    until: string;
    timezone: string;
    bucket: Bucket;
    dimension: Dimension;
    metric: Metric;
    filters: Filters;
    members?: string[];
};
export type Analysis = {
    snapshot_id: string;
    query: Query;
    summary: Values;
    previous_summary: Values;
    members: Member[];
    series?: { key: string; label: string }[];
    changes?: Partial<Record<Metric, Delta>>;
    knownCostChange?: Delta;
    trend: Point[];
    facets: Record<FilterKey, { key: string; label: string }[]>;
    coverage: {
        sources: Source[];
        warnings: string[];
        updated_at: string | null;
    };
    pricing: { label: string };
};
export type SessionDetail = {
    harness: string;
    session_id: string;
    project: string | null;
    parent_session_id: string | null;
    summary: Values;
    calls: {
        timestamp: string;
        model: string;
        purpose: string | null;
        values: Values;
    }[];
    children: { harness: string; session_id: string; summary?: Values }[];
    snapshot_id?: string;
};
