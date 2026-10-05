import { useEffect, useMemo, useRef, useState } from "react";
import { usePlotArea, useXAxisInverseDataSnapScale } from "recharts";
import type {
    Analysis,
    Delta,
    Dimension,
    FilterKey,
    Member,
    Metric,
    Query,
    Values,
} from "./types";
import {
    deltaPercent,
    dateInput,
    exactNumber,
    formatMetric,
    formatNumber,
    metricLabels,
} from "./format";
import "./insights.css";
const dimensions: Record<Dimension, string> = {
    harness: "来源",
    model: "模型",
    project: "项目",
    provider: "Provider",
    account: "账号",
    purpose: "用途",
    agent_type: "代理类型",
    service_tier: "运行模式",
    session: "会话",
};
const metrics: Metric[] = [
    "cost",
    "tokens",
    "calls",
    "cost_per_call",
    "cost_per_million",
    "cache_rate",
];
const colors = [
    "var(--data-blue)",
    "var(--data-teal)",
    "var(--data-amber)",
    "var(--data-coral)",
    "var(--data-purple)",
    "var(--data-other)",
];
function displayedChange(
    change: Delta | undefined,
    now: number | null,
    before: number | null,
    metric: Metric = "cost",
) {
    if (now != null && before === 0 && now !== 0)
        return `${now > 0 ? "+" : "−"}${formatMetric(Math.abs(now), metric)}`;
    return change
        ? change.relative != null
            ? `${change.relative > 0 ? "+" : ""}${(change.relative * 100).toFixed(1)}%`
            : change.absolute == null
              ? "—"
              : change.absolute === 0
                ? "0.0%"
                : "—"
        : (deltaPercent(now, before) ?? "—");
}
function hasComparison(data: Analysis, metric: Metric) {
    return !(["cost", "cost_per_call", "cost_per_million"].includes(metric) &&
        (data.summary.unpriced > 0 || data.previous_summary.unpriced > 0)) &&
        value(data.summary, metric) != null && value(data.previous_summary, metric) != null &&
        data.changes?.[metric]?.absolute !== null;
}
function comparisonPeriod(data: Analysis) {
    const range = data.comparison_range;
    return range
        ? `${dateInput(range.since, data.query.timezone).replace("T", " ")} — ${dateInput(range.until, data.query.timezone).replace("T", " ")}`
        : "紧邻当前范围的上一段等长时间";
}
const memberColors = new Map<string, string>();
function memberColor(dimension: Dimension, key: string) {
    const id = `${dimension}:${key}`;
    if (!memberColors.has(id))
        memberColors.set(id, colors[memberColors.size % 5]);
    return memberColors.get(id)!;
}
const ratio = (m: Metric) =>
    [
        "cache_rate",
        "cost_per_call",
        "cost_per_million",
        "tpm",
        "rpm",
        "throughput_tps",
        "rps",
        "timed_tps",
    ].includes(m);
const value = (v: Values, m: Metric) => v[m] ?? null;
function Icon({
    name,
}: {
    name: "refresh" | "close" | "arrow" | "filter" | "clock" | "layers";
}) {
    const paths = {
        refresh:
            "M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.5-3L20 8M4 16l2.4 3a7 7 0 0 0 11.5-3",
        close: "M6 6l12 12M6 18L18 6",
        arrow: "M7 17L17 7M7 7h10v10",
        filter: "M4 5h16l-6 7v6l-4 2v-8z",
        clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
        layers: "M12 3l9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5",
    };
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d={paths[name]} />
        </svg>
    );
}
function Facet({
    name,
    options,
    selected,
    onChange,
}: {
    name: FilterKey;
    options: { key: string; label: string; tooltip?: string }[];
    selected: string[];
    onChange: (values: string[]) => void;
}) {
    const [open, setOpen] = useState(false),
        [search, setSearch] = useState("");
    const candidates = [
        ...options,
        ...selected
            .filter((k) => !options.some((v) => v.key === k))
            .map((key) => ({ key, label: name === "session" ? "未命名会话" : name === "project" ? "未记录项目名称" : name === "account" && !key ? "账号未知" : key || "未知归属", tooltip: key })),
    ];
    return (
        <div className="facet" data-testid={`filter-${name}`}>
            <button
                className={
                    selected.length ? "facet-trigger active" : "facet-trigger"
                }
                onClick={() => setOpen(!open)}
            >
                {dimensions[name]}
                <span>{selected.length || "全部"}</span>
                <small>⌄</small>
            </button>
            {open && (
                <>
                    <button
                        className="dismiss"
                        onClick={() => setOpen(false)}
                        tabIndex={-1}
                        title="关闭筛选"
                    />
                    <div className="facet-popover">
                        <input
                            autoFocus
                            placeholder={`搜索${dimensions[name]}…`}
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                        <div className="facet-list">
                            {candidates
                                .filter((v) =>
                                    `${v.label}\n${v.key}`.toLowerCase()
                                        .includes(search.toLowerCase()),
                                )
                                .map((v) => (
                                    <label key={v.key} title={`${v.label}\n${v.tooltip ?? v.key}`}>
                                        <input
                                            type="checkbox"
                                            checked={selected.includes(v.key)}
                                            onChange={() =>
                                                onChange(
                                                    selected.includes(v.key)
                                                        ? selected.filter(
                                                              (k) =>
                                                                  k !== v.key,
                                                          )
                                                        : [...selected, v.key],
                                                )
                                            }
                                        />
                                        <span title={`${v.label}\n${v.tooltip ?? v.key}`}>{v.label}</span>
                                    </label>
                                ))}
                            {!candidates.length && <p>当前范围没有候选值</p>}
                        </div>
                        <button
                            className="text-button"
                            onClick={() => {
                                onChange([]);
                                setOpen(false);
                            }}
                        >
                            清除此条件
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
function SummarySparkline({ data, metric }: { data: Analysis; metric: "cost" | "tokens" | "calls" }) {
    const points = data.trend.map((point) => ({
        start: point.window_start ?? point.start,
        end: point.window_end ?? point.end,
        value: point.total[metric],
        partial: metric === "cost" && point.total.cost_complete === false,
        unpriced: point.total.unpriced,
    }));
    const costUnknown = metric === "cost" && data.summary.calls > 0 && data.summary.cost == null;
    const known = costUnknown ? [] : points.filter((point) => point.value != null);
    const maximum = Math.max(0, ...known.map((point) => point.value!));
    const left = new Date(data.query.since).getTime();
    const right = new Date(data.query.until).getTime();
    const coordinates = points.map((point) => ({ ...point,
        x: right > left ? 5 + ((new Date(point.start).getTime() + new Date(point.end).getTime()) / 2 - left) / (right - left) * 190 : 100,
        y: point.value == null ? null : 39 - (maximum ? point.value / maximum : 0) * 32,
    }));
    let path = "", connected = false;
    for (const point of coordinates) {
        if (point.y == null) { connected = false; continue; }
        path += `${connected ? "L" : "M"}${point.x},${point.y} `;
        connected = true;
    }
    const period = `${dateInput(data.query.since, data.query.timezone).replace("T", " ")} — ${dateInput(data.query.until, data.query.timezone).replace("T", " ")}`;
    const label = `${metricLabels[metric]}趋势 · ${period}`;
    return (
        <div className={`summary-microtrend summary-microtrend-${metric}`}
            data-testid={`summary-sparkline-${metric}`} data-state={costUnknown ? "unknown" : known.length ? "available" : "empty"}>
            {known.length ? <svg viewBox="0 0 200 46" role="img" aria-label={label}>
                <title>{label}</title>
                <path d="M5,39 L195,39" className="sparkline-baseline" />
                <path d={path} className="sparkline-path" />
                {coordinates.map((point, i) => point.y == null ? null : <circle key={i}
                    cx={point.x} cy={point.y} r={known.length === 1 ? 3 : 2}
                    className="sparkline-point"
                    data-value={point.value} data-start={point.start} data-end={point.end}>
                    <title>{`${dateInput(point.start, data.query.timezone).replace("T", " ")} — ${dateInput(point.end, data.query.timezone).replace("T", " ")}（${data.query.timezone}）\n${metricLabels[metric]} ${metric === "cost" ? "$" : ""}${exactNumber(point.value!)}${point.partial ? ` · 已知估算小计，${exactNumber(point.unpriced)} 次无法估价` : ""}`}</title>
                </circle>)}
            </svg> : <div className="sparkline-empty" role="img" aria-label={label}>
                —
            </div>}
        </div>
    );
}

function MetricStrip({
    data,
    turnCount,
}: {
    data: Analysis;
    turnCount?: number;
}) {
    return (
        <>
        <header className="summary-heading">
            <h2>用量概览</h2>
            <span data-testid="resolved-range" title={data.query.timezone}>
                <span data-testid="summary-period">{dateInput(data.query.since, data.query.timezone).replace("T", " ")} — {dateInput(data.query.until, data.query.timezone).replace("T", " ")}</span>
            </span>
        </header>
        <section className="metric-strip" data-testid="summary">
            {(["cost", "tokens", "calls"] as const).map((m) => (
                <article key={m}>
                    <div className="metric-label">
                        {m === "calls" ? "模型调用" : metricLabels[m]}
                    </div>
                    <div className="metric-value">
                        <span data-testid={`summary-${m}`}
                        title={`${metricLabels[m]} ${m === "cost" && data.summary.cost != null ? "$" : ""}${value(data.summary, m) == null ? "未知" : exactNumber(value(data.summary, m)!)}`}>
                            {formatMetric(value(data.summary, m), m)}
                        </span>
                        {m === "cost" && data.summary.cost != null && data.summary.unpriced > 0 &&
                            <sup data-testid="summary-note-cost" title={`${formatNumber(data.summary.unpriced)} 次调用未计价`}>*</sup>}
                        {m === "tokens" && data.summary.input_complete === false &&
                            <sup data-testid="summary-note-tokens" title="部分请求未记录缓存写入">*</sup>}
                    </div>
                    <SummarySparkline data={data} metric={m} />
                    <div className="metric-foot">
                        <span>
                            {m === "cost"
                                ? "USD"
                                : m === "tokens"
                                  ? `输入 ${formatNumber(data.summary.input)} / 输出 ${formatNumber(data.summary.output)}`
                                  : `${formatNumber(data.summary.sessions)} 个会话`}
                        </span>
                        {hasComparison(data, m) && <span
                            className="change"
                            data-testid={`summary-change-${m}`}
                            title={comparisonPeriod(data)}
                        >
                            <small>环比 </small>{displayedChange(
                                data.changes?.[m],
                                value(data.summary, m),
                                value(data.previous_summary, m),
                                m,
                            )}
                        </span>}
                    </div>
                </article>
            ))}
            <article>
                <div className="metric-label">轮次</div>
                <div className="metric-value" data-testid="turn-count">
                    {turnCount == null ? "—" : formatNumber(turnCount)}
                </div>
            </article>
        </section>
        </>
    );
}
// A direct click resolves a bucket from the public axis scale. Tooltip hover
// state can still be unset when a user clicks immediately after entering a chart.
function BucketZoom({
    target,
    rows,
    onZoom,
}: {
    target: React.RefObject<HTMLDivElement | null>;
    rows: { time: string; end: string }[];
    onZoom: (start: string, end: string) => void;
}) {
    const plot = usePlotArea();
    const nearest = useXAxisInverseDataSnapScale();
    useEffect(() => {
        const node = target.current;
        if (!node || !plot || !nearest) return;
        function click(event: MouseEvent) {
            const svg = node!.querySelector<SVGSVGElement>(".recharts-surface");
            if (!svg) return;
            const rect = svg.getBoundingClientRect();
            const width = svg.viewBox.baseVal.width || rect.width;
            const height = svg.viewBox.baseVal.height || rect.height;
            const x = ((event.clientX - rect.left) * width) / rect.width;
            const y = ((event.clientY - rect.top) * height) / rect.height;
            if (
                x < plot!.x ||
                x > plot!.x + plot!.width ||
                y < plot!.y ||
                y > plot!.y + plot!.height
            )
                return;
            const bucket = rows.find((row) => row.time === nearest!(x));
            if (bucket) onZoom(bucket.time, bucket.end);
        }
        node.addEventListener("click", click);
        return () => node.removeEventListener("click", click);
    }, [target, plot, nearest, rows, onZoom]);
    return null;
}
function Comparison({
    data,
    metric,
    onDetail,
}: {
    data: Analysis;
    metric: Metric;
    onDetail: (m: Member) => void;
}) {
    const current = value(data.summary, metric),
        previous = value(data.previous_summary, metric);
    const changes = [...data.members]
        .map((m) => ({
            m,
            delta: m.changes?.[metric]?.absolute ?? (m.changes ||
                value(m.values, metric) == null || value(m.previous, metric) == null
                ? null : value(m.values, metric)! - value(m.previous, metric)!),
        }))
        .filter((r) => r.delta != null)
        .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!))
        .slice(0, 4);
    return (
        <section className="comparison">
            <div className="comparison-heading" title={comparisonPeriod(data)}>
                <strong>{displayedChange(data.changes?.[metric], current, previous, metric)}</strong>
                <span className="muted">{formatMetric(previous, metric)} → {formatMetric(current, metric)}</span>
            </div>
            <div className="contributions">
                {changes.map(({ m, delta }) => (
                    <button key={m.key} title={m.tooltip ?? m.label} onClick={() => onDetail(m)}>
                        <span>{m.label}</span>
                        <b className={delta! > 0 ? "increase" : "decrease"}>
                            {delta! > 0 ? "+" : "−"}{formatMetric(Math.abs(delta!), metric)}
                        </b>
                        <small>↗</small>
                    </button>
                ))}
            </div>
        </section>
    );
}
function Ledger({
    data,
    q,
    onDetail,
    onFilter,
}: {
    data: Analysis;
    q: Query;
    onDetail: (m: Member) => void;
    onFilter: (m: Member) => void;
}) {
    const [search, setSearch] = useState(""),
        [sort, setSort] = useState<Metric>(q.metric),
        [desc, setDesc] = useState(true),
        [page, setPage] = useState(0);
    useEffect(() => {
        setSort(q.metric);
        setPage(0);
    }, [q.metric, q.dimension, JSON.stringify(q.filters)]);
    const rows = useMemo(
        () =>
            data.members
                .filter((m) =>
                    m.label.toLowerCase().includes(search.toLowerCase()),
                )
                .sort((a, b) => {
                    const av = value(a.values, sort),
                        bv = value(b.values, sort);
                    if (av == null) return bv == null ? 0 : 1;
                    if (bv == null) return -1;
                    return desc ? bv - av : av - bv;
                }),
        [data.members, search, sort, desc],
    );
    const pageCount = Math.max(1, Math.ceil(rows.length / 15)),
        currentPage = Math.min(page, pageCount - 1);
    return (
        <section className="ledger panel" data-testid="ledger">
            <div className="panel-title">
                <div>
                    <h2>
                        用量汇总 <span>{rows.length} 项</span>
                    </h2>
                </div>
                <input
                    className="table-search"
                    placeholder="搜索当前汇总…"
                    value={search}
                    onChange={(e) => {
                        setSearch(e.target.value);
                        setPage(0);
                    }}
                />
            </div>
            <div className="table-scroll">
                <table>
                    <thead>
                        <tr>
                            <th className="name-col">
                                {dimensions[q.dimension]}
                            </th>
                            {(
                                [
                                    "cost",
                                    "tokens",
                                    "calls",
                                    "cache_rate",
                                ] as Metric[]
                            ).map((m) => (
                                <th key={m}>
                                    <button
                                        onClick={() => {
                                            setSort(m);
                                            setDesc(sort === m ? !desc : true);
                                        }}
                                    >
                                        {metricLabels[m]}
                                        {sort === m ? (desc ? " ↓" : " ↑") : ""}
                                    </button>
                                </th>
                            ))}
                            <th>费用变化</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {rows
                            .slice(currentPage * 15, currentPage * 15 + 15)
                            .map((m, i) => (
                                <tr key={m.key}>
                                    <td>
                                        <button
                                            className="row-name"
                                            title={m.tooltip ?? m.label}
                                            onClick={() => onDetail(m)}
                                        >
                                            <span className="row-index">
                                                {currentPage * 15 + i + 1}
                                            </span>
                                            <span>{m.label}</span>
                                        </button>
                                        {m.subtitle && (
                                            <small className="row-subtitle">
                                                {m.subtitle}
                                            </small>
                                        )}
                                    </td>
                                    <td
                                        title={
                                            m.values.unpriced
                                                ? `缺价 ${m.values.unpriced} 条，当前显示已知小计`
                                                : undefined
                                        }
                                    >
                                        {formatMetric(m.values.cost, "cost")}
                                        {m.values.unpriced > 0 && (
                                            <span className="partial">*</span>
                                        )}
                                    </td>
                                    <td title={exactNumber(m.values.tokens)}>
                                        {formatNumber(m.values.tokens)}
                                    </td>
                                    <td>{exactNumber(m.values.calls)}</td>
                                    <td>
                                        {formatMetric(
                                            m.values.cache_rate,
                                            "cache_rate",
                                        )}
                                    </td>
                                    <td className="muted">
                                        {displayedChange(
                                            m.changes?.cost,
                                            m.values.cost,
                                            m.previous.cost,
                                        )}
                                    </td>
                                    <td>
                                        {q.dimension !== "session" && (
                                            <button
                                                className="icon-button"
                                                title={`筛选${m.label}`}
                                                onClick={() => onFilter(m)}
                                            >
                                                <Icon name="filter" />
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                    </tbody>
                </table>
                {!rows.length && (
                    <div className="empty">
                        当前条件没有记录。修改时间范围或清除筛选。
                    </div>
                )}
            </div>
            <div className="table-bottom">
                <span>{rows.length} 项</span>
                <div>
                    <button
                        disabled={currentPage === 0}
                        onClick={() => setPage(currentPage - 1)}
                    >
                        上一页
                    </button>
                    <span>
                        {currentPage + 1} / {pageCount}
                    </span>
                    <button
                        disabled={currentPage === pageCount - 1}
                        onClick={() => setPage(currentPage + 1)}
                    >
                        下一页
                    </button>
                </div>
            </div>
        </section>
    );
}
export {
    Icon,
    Facet,
    MetricStrip,
    BucketZoom,
    Comparison,
    hasComparison,
    Ledger,
    dimensions,
    memberColor,
    ratio,
    value,
};
