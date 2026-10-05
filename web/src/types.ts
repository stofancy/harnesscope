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
    | "cache_rate"
    | "input"
    | "output"
    | "cache_read"
    | "cache_write"
    | "tpm"
    | "rpm"
    | "throughput_tps"
    | "rps"
    | "timed_tps";
export type Bucket =
    | "auto"
    | "second"
    | "5second"
    | "30second"
    | "10second"
    | "minute"
    | "5minute"
    | "15minute"
    | "hour"
    | "day"
    | "week"
    | "month";
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
    tpm?: number | null;
    rpm?: number | null;
    throughput_tps?: number | null;
    rps?: number | null;
    input_net?: number | null;
    cache_write?: number | null;
    timed_tps?: number | null;
    seconds?: number;
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
    window_start?: string;
    window_end?: string;
    seconds?: number;
    timing?: {
        key: string;
        harness: string;
        kind: string;
        value: number | null;
        output: number;
        seconds: number;
        samples: number;
    }[];
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
    bucket_resolved?: Bucket;
    timing_members?: {
        key: string;
        harness: string;
        kind: string;
        label: string;
    }[];
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

export type GlobalQuery = Pick<
    Query,
    "since" | "until" | "timezone" | "bucket" | "filters"
>;
export type ChartKind = "area" | "line" | "bar";
export type PanelId = "consumption" | "rate" | "cache" | "speed";
export type PanelConfig = {
    dimension: Dimension;
    metric: Metric;
    chart: ChartKind;
    share: boolean;
    members: string[];
};
export type TurnRow = {
    key: string;
    harness: string;
    session_id: string;
    turn_id: string;
    start: string;
    end: string | null;
    status: string;
    duration_seconds: number | null;
    full_window: boolean;
    recorded_usage_available: boolean;
    usage_scope: string;
    boundary_quality: string;
    tool_coverage: string;
    window_metrics: Values;
    full_metrics: Values | null;
    tool_calls_known: number;
    tool_calls: number | null;
    project: string | null;
    agent_type: string | null;
};
export type TurnTool = {
    tool_name: string;
    calls: number;
    status_counts: Record<string, number>;
    duration_p50: number | null;
    duration_p95: number | null;
    duration_samples: number;
};
export type TurnsAnalysis = {
    snapshot_id: string;
    query: GlobalQuery;
    bucket_resolved: Bucket;
    summary: {
        turns: number;
        status_counts: Record<string, number>;
        metrics: Values;
        tool_calls_known: number;
        tool_calls: number | null;
        tools_per_turn: number | null;
        duration_p50: number | null;
        duration_p95: number | null;
        duration_samples: number;
        full_turns: number;
        duration_boundary_quality?: Record<string, number>;
        per_turn: {
            samples: number;
            scope?: string;
            boundary_quality?: Record<string, number>;
            calls: number | null;
            tokens: number | null;
            cost_usd: number | null;
            tokens_known_mean?: number | null;
            cost_usd_known_mean?: number | null;
            tokens_complete_samples?: number;
            cost_complete_samples?: number;
            cost_priced_samples?: number;
        };
    };
    trend: {
        start: string;
        end: string;
        seconds: number;
        window_start: string;
        window_end: string;
        metrics: Values;
        turns: number;
        status_counts: Record<string, number>;
        tool_calls_known: number;
        tool_calls: number | null;
        duration_p50: number | null;
        duration_p95: number | null;
    }[];
    tools: {
        coverage: string;
        scope: string;
        status_counts: Record<string, number>;
        rows: TurnTool[];
    };
    rows: TurnRow[];
    total: number;
    offset: number;
    limit: number;
    coverage: {
        boundary_quality: Record<string, number>;
        tool_coverage: Record<string, number>;
        truncated_turns: number;
        unassigned_calls: number;
        usage_scope: string;
        usage_quality?: Record<string, number>;
    };
};
export type TurnDetail = {
    snapshot_id: string;
    turn: TurnRow;
    window_metrics: Values;
    recorded_metrics: Values;
    usage_scope: string;
    calls: {
        key: string;
        timestamp_us: number;
        model: string;
        provider: string | null;
        purpose: string | null;
        service_tier: string | null;
        input_net: number;
        cache_read: number;
        cache_write: number | null;
        output: number;
        cost_usd: number | null;
        in_window: boolean;
        quality: string;
    }[];
    tools: {
        key: string;
        tool_name: string;
        status: string;
        start_us: number;
        end_us: number | null;
        duration_seconds?: number | null;
        in_window: boolean;
    }[];
    related_turns: {
        harness: string;
        session_id: string;
        turn_id: string;
        status?: string;
        relationship?: string;
    }[];
};

export type UsageGroup = "request" | "session" | "turn" | "model" | "harness";
export type UsageView = {
    group: UsageGroup;
    sort: string;
    order: "asc" | "desc";
    offset: number;
    limit: number;
};
export type UsageIdentity = {
    harness?: string | null;
    session_id?: string | null;
    turn_id?: string | null;
    model?: string | null;
    event_key?: string | null;
};
export type UsageDrill = {
    identity: UsageIdentity;
    label: string;
    group: UsageGroup;
};
export type UsageRow = {
    key: string;
    identity: UsageIdentity;
    first: string;
    last: string;
    projects: string[];
    harnesses: string[];
    models: string[];
    metrics: Values;
    response_tps: number | null;
    turn_tps: number | null;
    timing: Timing[];
};
export type UsageAnalysis = {
    snapshot_id: string;
    query: GlobalQuery;
    group: UsageGroup;
    sort: string;
    order: "asc" | "desc";
    summary: Values;
    coverage: Analysis["coverage"];
    facets: Analysis["facets"];
    rows: UsageRow[];
    total: number;
    offset: number;
    limit: number;
};
