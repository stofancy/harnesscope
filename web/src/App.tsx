import { useEffect, useMemo, useRef, useState } from "react";
import {
    Bar,
    BarChart,
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
    usePlotArea,
    useXAxisInverseDataSnapScale,
} from "recharts";
import type {
    Analysis,
    Delta,
    Dimension,
    FilterKey,
    Member,
    Metric,
    Query,
    SessionDetail,
    Values,
} from "./types";
import {
    analyze,
    demo,
    refresh,
    sessionDetail,
    status,
    type Status,
} from "./api";
import {
    dateInput,
    deltaPercent,
    exactNumber,
    formatMetric,
    formatNumber,
    inputDate,
    metricLabels,
    timeLabel,
} from "./format";
const dimensions: Record<Dimension, string> = {
    harness: "工具",
    model: "模型",
    project: "项目",
    provider: "Provider",
    purpose: "用途",
    agent_type: "代理类型",
    service_tier: "服务档位",
    session: "会话",
};
const filterKeys: FilterKey[] = [
    "harness",
    "model",
    "project",
    "provider",
    "purpose",
];
const metrics = Object.keys(metricLabels) as Metric[];
const colors = [
    "#26766a",
    "#6881b8",
    "#b9814b",
    "#9581a8",
    "#71815b",
    "#bcc4bf",
];
function displayedChange(
    change: Delta | undefined,
    now: number | null,
    before: number | null,
) {
    return change
        ? change.relative != null
            ? `${change.relative > 0 ? "+" : ""}${(change.relative * 100).toFixed(1)}%`
            : change.absolute == null
              ? "比较未知"
              : change.absolute === 0
                ? "0.0%"
                : "新增"
        : (deltaPercent(now, before) ?? "比较未知");
}
const memberColors = new Map<string, string>();
function memberColor(dimension: Dimension, key: string) {
    const id = `${dimension}:${key}`;
    if (!memberColors.has(id))
        memberColors.set(id, colors[memberColors.size % 5]);
    return memberColors.get(id)!;
}
const ratio = (m: Metric) =>
    ["cache_rate", "cost_per_call", "cost_per_million"].includes(m);
function initialQuery(): Query {
    const until = new Date(),
        since = new Date(until.getTime() - 7 * 86400000);
    return {
        since: since.toISOString(),
        until: until.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        bucket: "day",
        dimension: "harness",
        metric: "cost",
        filters: {},
    };
}
function value(v: Values, m: Metric) {
    return v[m];
}
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
    options: { key: string; label: string }[];
    selected: string[];
    onChange: (values: string[]) => void;
}) {
    const [open, setOpen] = useState(false),
        [search, setSearch] = useState("");
    const candidates = [
        ...options,
        ...selected
            .filter((k) => !options.some((v) => v.key === k))
            .map((key) => ({ key, label: key || "未知归属" })),
    ];
    return (
        <div className="facet">
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
                                    v.label
                                        .toLowerCase()
                                        .includes(search.toLowerCase()),
                                )
                                .map((v) => (
                                    <label key={v.key}>
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
                                        <span title={v.label}>{v.label}</span>
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
function TimeRange({
    query,
    onChange,
}: {
    query: Query;
    onChange: (q: Query) => void;
}) {
    const [open, setOpen] = useState(false),
        [start, setStart] = useState(""),
        [end, setEnd] = useState(""),
        [error, setError] = useState("");
    function edit() {
        setStart(dateInput(query.since, query.timezone));
        setEnd(dateInput(query.until, query.timezone));
        setError("");
        setOpen(true);
    }
    function apply() {
        try {
            const since = inputDate(start, query.timezone),
                until = inputDate(end, query.timezone);
            if (since >= until) throw new Error("结束时间须晚于开始时间");
            onChange({ ...query, since, until });
            setOpen(false);
        } catch (e) {
            setError((e as Error).message);
        }
    }
    return (
        <div className="range">
            <div className="presets">
                {[1, 7, 30].map((days) => (
                    <button
                        key={days}
                        onClick={() => {
                            const until = new Date();
                            onChange({
                                ...query,
                                since: new Date(
                                    until.getTime() - days * 86400000,
                                ).toISOString(),
                                until: until.toISOString(),
                                bucket: days === 1 ? "hour" : "day",
                            });
                        }}
                    >
                        近{days === 1 ? "24小时" : `${days}天`}
                    </button>
                ))}
            </div>
            <button className="range-button" onClick={edit}>
                <Icon name="clock" />
                {timeLabel(query.since, query.timezone)}
                <span>—</span>
                {timeLabel(query.until, query.timezone)}
                <small>⌄</small>
            </button>
            <select
                value={query.timezone}
                title="时间分桶时区"
                onChange={(e) =>
                    onChange({ ...query, timezone: e.target.value })
                }
            >
                {[
                    ...new Set([
                        query.timezone,
                        "Asia/Singapore",
                        "Asia/Shanghai",
                        "UTC",
                        "America/Los_Angeles",
                        "America/New_York",
                        "Europe/London",
                    ]),
                ].map((z) => (
                    <option key={z}>{z}</option>
                ))}
            </select>
            {open && (
                <div className="modal-backdrop" onClick={() => setOpen(false)}>
                    <div
                        className="time-dialog"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="panel-title">
                            <h2>自定义时间范围</h2>
                            <button
                                className="icon-button"
                                onClick={() => setOpen(false)}
                            >
                                <Icon name="close" />
                            </button>
                        </div>
                        <p className="muted">
                            按 {query.timezone}{" "}
                            输入，精确到秒；结束时间不含在统计范围内。
                        </p>
                        <label>
                            开始
                            <input
                                type="datetime-local"
                                step="1"
                                value={start}
                                onChange={(e) => setStart(e.target.value)}
                            />
                        </label>
                        <label>
                            结束
                            <input
                                type="datetime-local"
                                step="1"
                                value={end}
                                onChange={(e) => setEnd(e.target.value)}
                            />
                        </label>
                        {error && <p className="error-text">{error}</p>}
                        <button className="primary" onClick={apply}>
                            应用时间范围
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
function MetricStrip({ data }: { data: Analysis }) {
    return (
        <section className="metric-strip">
            {(["cost", "tokens", "calls", "cache_rate"] as Metric[]).map(
                (m) => (
                    <article key={m}>
                        <div className="metric-label">{metricLabels[m]}</div>
                        <div className="metric-value">
                            {formatMetric(value(data.summary, m), m)}
                        </div>
                        <div className="metric-foot">
                            <span>
                                {m === "cost"
                                    ? data.summary.unpriced
                                        ? `缺价 ${formatNumber(data.summary.unpriced)} 条调用`
                                        : "已知估算 · USD"
                                    : m === "tokens"
                                      ? `${data.summary.input_complete === false ? "已记录小计 · " : ""}输入 ${formatNumber(data.summary.input)} · 输出 ${formatNumber(data.summary.output)}`
                                      : m === "calls"
                                        ? `${formatNumber(data.summary.sessions)} 个会话`
                                        : "按已测输入 Tokens 加权"}
                            </span>
                            <span className="change">
                                {displayedChange(
                                    data.changes?.[m],
                                    value(data.summary, m),
                                    value(data.previous_summary, m),
                                )}
                                <small> 较前窗</small>
                            </span>
                        </div>
                    </article>
                ),
            )}
        </section>
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
function Trend({
    data,
    q,
    share,
    selected,
    onSelect,
    onZoom,
}: {
    data: Analysis;
    q: Query;
    share: boolean;
    selected: string[];
    onSelect: (keys: string[]) => void;
    onZoom: (start: string, end: string) => void;
}) {
    const chartElement = useRef<HTMLDivElement>(null);
    const [memberSearch, setMemberSearch] = useState("");
    const ranked = [...data.members].sort(
        (a, b) =>
            (value(b.values, q.metric) ?? -1) -
            (value(a.values, q.metric) ?? -1),
    );
    const keys = selected.length
        ? selected
        : ranked.slice(0, 5).map((m) => m.key);
    const metadata = data.series ?? [
        ...keys.map((key) => ({
            key,
            label: data.members.find((m) => m.key === key)?.label ?? key,
        })),
        ...(!ratio(q.metric) && data.members.length > keys.length
            ? [{ key: "__other__", label: "其他" }]
            : []),
    ];
    const series = metadata
        .filter((m) => !ratio(q.metric) || m.key !== "__other__")
        .map((m, i) => ({
            ...m,
            id: `s${i}`,
            color:
                m.key === "__other__"
                    ? colors[5]
                    : memberColor(q.dimension, m.key),
        }));
    const rows = data.trend.map((p) => {
        const result: Record<string, number | string | null> = {
            time: p.start,
            end: p.end,
            total: value(p.total, q.metric),
            unpriced: p.total.unpriced,
        };
        for (const s of series) {
            const n = p.members[s.key]
                ? value(p.members[s.key], q.metric)
                : null;
            result[s.id] = share
                ? p.shares?.[s.key] != null
                    ? p.shares[s.key]! * 100
                    : null
                : n;
        }
        return result;
    });
    const Chart = ratio(q.metric) || selected.length ? LineChart : BarChart;
    return (
        <div className="trend-layout">
            <div className="trend-main">
                <div className="chart-note">
                    <span>
                        {selected.length
                            ? "所选成员比较"
                            : ratio(q.metric)
                              ? "各成员效率趋势"
                              : "当前维度随时间变化"}{" "}
                        ·{" "}
                        {q.bucket === "hour"
                            ? "每小时"
                            : q.bucket === "day"
                              ? "每日"
                              : "每周"}
                        {share
                            ? q.metric === "cost"
                                ? " · 已知费用内部占比"
                                : " · 构成占比"
                            : ""}
                    </span>
                    <span>点击时间桶可缩小范围</span>
                </div>
                <div className="chart" ref={chartElement}>
                    <ResponsiveContainer width="100%" height="100%">
                        <Chart
                            data={rows}
                            margin={{ top: 18, right: 12, bottom: 8, left: 0 }}
                        >
                            <BucketZoom
                                target={chartElement}
                                rows={rows.map((row) => ({
                                    time: String(row.time),
                                    end: String(row.end),
                                }))}
                                onZoom={onZoom}
                            />
                            <CartesianGrid
                                vertical={false}
                                stroke="#e6e8e2"
                                strokeDasharray="3 5"
                            />
                            <XAxis
                                dataKey="time"
                                tickFormatter={(s) =>
                                    timeLabel(s, q.timezone).replace(
                                        /\s\d{2}:\d{2}$/,
                                        "",
                                    )
                                }
                                axisLine={false}
                                tickLine={false}
                                minTickGap={35}
                                tick={{ fill: "#7a827c", fontSize: 11 }}
                            />
                            <YAxis
                                width={62}
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: "#7a827c", fontSize: 11 }}
                                tickFormatter={(n) =>
                                    share ? `${n}%` : formatMetric(n, q.metric)
                                }
                                domain={share ? [0, 100] : ["auto", "auto"]}
                            />
                            <Tooltip
                                content={({ active, payload, label }) =>
                                    active && payload?.length ? (
                                        <div className="chart-tooltip">
                                            <strong>
                                                {timeLabel(
                                                    String(label),
                                                    q.timezone,
                                                    true,
                                                )}
                                            </strong>
                                            {payload.map((p) => (
                                                <div key={String(p.dataKey)}>
                                                    <i
                                                        style={{
                                                            background: p.color,
                                                        }}
                                                    />
                                                    {p.name}
                                                    <b>
                                                        {share
                                                            ? `${Number(p.value).toFixed(1)}%`
                                                            : formatMetric(
                                                                  Number(
                                                                      p.value,
                                                                  ),
                                                                  q.metric,
                                                              )}
                                                    </b>
                                                </div>
                                            ))}
                                            {!ratio(q.metric) && (
                                                <div className="tooltip-total">
                                                    合计
                                                    <b>
                                                        {formatMetric(
                                                            payload[0]?.payload
                                                                .total,
                                                            q.metric,
                                                        )}
                                                    </b>
                                                </div>
                                            )}
                                            {q.metric === "cost" &&
                                                Number(
                                                    payload[0]?.payload
                                                        .unpriced,
                                                ) > 0 && (
                                                    <p className="tooltip-warning">
                                                        缺价{" "}
                                                        {
                                                            payload[0]?.payload
                                                                .unpriced
                                                        }{" "}
                                                        条，显示已知小计
                                                    </p>
                                                )}
                                        </div>
                                    ) : null
                                }
                            />
                            {series.map((s) =>
                                Chart === LineChart ? (
                                    <Line
                                        key={s.id}
                                        dataKey={s.id}
                                        name={s.label}
                                        stroke={s.color}
                                        strokeWidth={2}
                                        dot={false}
                                        activeDot={{ r: 4 }}
                                        isAnimationActive={false}
                                        connectNulls={false}
                                    />
                                ) : (
                                    <Bar
                                        key={s.id}
                                        dataKey={s.id}
                                        name={s.label}
                                        stackId="usage"
                                        fill={s.color}
                                        maxBarSize={40}
                                        isAnimationActive={false}
                                    />
                                ),
                            )}
                        </Chart>
                    </ResponsiveContainer>
                </div>
                <div className="chart-legend">
                    {series.map((s) => (
                        <span key={s.id}>
                            <i style={{ background: s.color }} />
                            {s.label}
                        </span>
                    ))}
                </div>
            </div>
            <aside className="member-panel">
                <div className="member-title">
                    成员比较<span>{data.members.length} 项</span>
                </div>
                <p className="muted tiny">选择成员查看折线，最多 5 项</p>
                <input
                    className="member-search"
                    placeholder={`搜索全部 ${ranked.length} 项…`}
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                />
                {ranked
                    .filter((m) =>
                        m.label
                            .toLowerCase()
                            .includes(memberSearch.toLowerCase()),
                    )
                    .slice(0, 50)
                    .map((m, i) => (
                        <label
                            className="member-row"
                            data-member={m.label}
                            key={m.key}
                        >
                            <input
                                type="checkbox"
                                checked={selected.includes(m.key)}
                                disabled={
                                    !selected.includes(m.key) &&
                                    selected.length === 5
                                }
                                onChange={() =>
                                    onSelect(
                                        selected.includes(m.key)
                                            ? selected.filter(
                                                  (k) => k !== m.key,
                                              )
                                            : [...selected, m.key],
                                    )
                                }
                            />
                            <span title={m.label}>{m.label}</span>
                            <b>
                                {formatMetric(
                                    value(m.values, q.metric),
                                    q.metric,
                                )}
                            </b>
                            <div
                                className="member-bar"
                                style={{
                                    width: `${Math.min(100, Math.max(0, ((value(m.values, q.metric) ?? 0) / (value(ranked[0].values, q.metric) || 1)) * 100))}%`,
                                    background: memberColor(q.dimension, m.key),
                                }}
                            />
                        </label>
                    ))}
                {ranked.length > 50 && (
                    <p className="muted tiny">
                        最多展示 50 项，可搜索全部成员。
                    </p>
                )}
                {selected.length > 0 && (
                    <button
                        className="text-button"
                        onClick={() => onSelect([])}
                    >
                        恢复前 5 名＋其他
                    </button>
                )}
            </aside>
        </div>
    );
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
    const knownMode =
        metric === "cost" &&
        (data.summary.unpriced > 0 || data.previous_summary.unpriced > 0);
    const changes = [...data.members]
        .map((m) => ({
            m,
            delta:
                (knownMode
                    ? m.knownCostChange?.absolute
                    : m.changes?.[metric]?.absolute) ??
                (m.changes
                    ? null
                    : value(m.values, metric) == null ||
                        value(m.previous, metric) == null
                      ? null
                      : value(m.values, metric)! - value(m.previous, metric)!),
        }))
        .filter((r) => r.delta != null)
        .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!))
        .slice(0, 4);
    return (
        <section className="comparison">
            <div className="comparison-heading">
                <span className="eyebrow">较上一等长窗口</span>
                <strong>
                    {displayedChange(data.changes?.[metric], current, previous)}
                </strong>
                <span className="muted">
                    {formatMetric(previous, metric)} →{" "}
                    {formatMetric(current, metric)}
                </span>
                <small>
                    {knownMode
                        ? "已知费用小计的成员变化 · 完整费用变化未知"
                        : ratio(metric)
                          ? "成员效率变化"
                          : "变化由这些成员推动"}
                </small>
            </div>
            <div className="contributions">
                {changes.map(({ m, delta }) => (
                    <button key={m.key} onClick={() => onDetail(m)}>
                        <span title={m.label}>{m.label}</span>
                        <b className={delta! > 0 ? "increase" : "decrease"}>
                            {delta! > 0 ? "+" : "−"}
                            {formatMetric(Math.abs(delta!), metric)}
                        </b>
                        <Icon name="arrow" />
                    </button>
                ))}
                {!changes.length && (
                    <span className="muted">
                        {metric === "cost" &&
                        data.knownCostChange?.absolute != null
                            ? `已知小计变化 ${data.knownCostChange.absolute >= 0 ? "+" : "−"}${formatMetric(Math.abs(data.knownCostChange.absolute), "cost")}；完整费用变化未知。`
                            : "没有可比较的已知数据"}
                    </span>
                )}
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
        <section className="ledger panel">
            <div className="panel-title">
                <div>
                    <h2>
                        用量明细 <span>{rows.length} 项</span>
                    </h2>
                    <p className="muted tiny">
                        当前筛选结果 · 按{dimensions[q.dimension]}查看
                    </p>
                </div>
                <input
                    className="table-search"
                    placeholder="搜索当前明细…"
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
                                            title={m.label}
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
                <span>未知数值显示 — · * 费用为已知小计</span>
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
function Detail({
    member,
    q,
    onClose,
    onFilter,
    onSessions,
}: {
    member: Member;
    q: Query;
    onClose: () => void;
    onFilter: (identity?: { harness: string; session_id: string }) => void;
    onSessions: () => void;
}) {
    const [detail, setDetail] = useState<SessionDetail | null>(null),
        [error, setError] = useState("");
    const requestSequence = useRef(0);
    async function loadSession(harness: string, id: string) {
        const sequence = ++requestSequence.current;
        setError("");
        try {
            const loaded = await sessionDetail(harness, id, q);
            if (sequence === requestSequence.current) setDetail(loaded);
        } catch (e) {
            if (sequence === requestSequence.current)
                setError((e as Error).message);
        }
    }
    useEffect(() => {
        setDetail(null);
        setError("");
        if (q.dimension === "session" && member.harness && member.session_id)
            void loadSession(member.harness, member.session_id);
        return () => {
            requestSequence.current++;
        };
    }, [member.key, q]);
    const shownValues = detail?.summary ?? member.values;
    return (
        <div className="drawer-backdrop" onClick={onClose}>
            <aside className="drawer" onClick={(e) => e.stopPropagation()}>
                <div className="panel-title">
                    <span className="eyebrow">
                        {dimensions[q.dimension]}详情
                    </span>
                    <button
                        className="icon-button"
                        title="关闭详情"
                        onClick={onClose}
                    >
                        <Icon name="close" />
                    </button>
                </div>
                <h2 className="detail-name">
                    {detail && detail.session_id !== member.session_id
                        ? detail.session_id
                        : member.label}
                </h2>
                <p className="muted">
                    {timeLabel(q.since, q.timezone, true)} —{" "}
                    {timeLabel(q.until, q.timezone, true)}
                </p>
                <div className="detail-metrics">
                    {metrics.map((m) => (
                        <div key={m}>
                            <span>{metricLabels[m]}</span>
                            <strong>
                                {formatMetric(value(shownValues, m), m)}
                            </strong>
                        </div>
                    ))}
                </div>
                {shownValues.unpriced > 0 && (
                    <p className="notice">
                        {shownValues.unpriced} 条记录缺价，费用仅含已知部分。
                    </p>
                )}
                {
                    <div className="drawer-actions">
                        <button
                            className="primary"
                            onClick={() =>
                                onFilter(
                                    detail
                                        ? {
                                              harness: detail.harness,
                                              session_id: detail.session_id,
                                          }
                                        : undefined,
                                )
                            }
                        >
                            筛选此{dimensions[q.dimension]}
                        </button>
                        {q.dimension !== "session" && (
                            <button onClick={onSessions}>
                                查看相关会话 <Icon name="arrow" />
                            </button>
                        )}
                    </div>
                }
                {error && <p className="error-text">{error}</p>}
                {detail && (
                    <>
                        <h3>速度与计时覆盖</h3>
                        {detail.summary.tps?.length ? (
                            detail.summary.tps.map((t) => (
                                <div
                                    className="call-row"
                                    key={`${t.harness}:${t.kind}`}
                                >
                                    <span>
                                        {t.harness} · {t.kind}
                                        <small>
                                            {t.samples} 个完整样本 ·{" "}
                                            {t.seconds.toFixed(1)} 秒
                                        </small>
                                    </span>
                                    <b>
                                        {t.tps == null
                                            ? "—"
                                            : `${t.tps.toFixed(1)} TPS`}
                                    </b>
                                </div>
                            ))
                        ) : (
                            <p className="muted">无可用计时样本</p>
                        )}
                        <h3>会话归属</h3>
                        <p className="muted">
                            项目：{detail.project ?? "未知"}
                            <br />
                            父会话：{detail.parent_session_id ?? "未记录"}
                        </p>
                        <h3>调用记录</h3>
                        {detail.calls.map((c, i) => (
                            <div className="call-row" key={i}>
                                <span>
                                    {timeLabel(c.timestamp, q.timezone)}
                                    <small>
                                        {c.model} · {c.purpose ?? "用途未知"}
                                    </small>
                                </span>
                                <b>{formatMetric(c.values.cost, "cost")}</b>
                            </div>
                        ))}
                        {detail.children.length > 0 && (
                            <>
                                <h3>子会话</h3>
                                {detail.children.map((c) => (
                                    <button
                                        className="call-row child-session"
                                        key={c.session_id}
                                        onClick={() =>
                                            void loadSession(
                                                c.harness,
                                                c.session_id,
                                            )
                                        }
                                    >
                                        <span>{c.session_id}</span>
                                        <Icon name="arrow" />
                                    </button>
                                ))}
                            </>
                        )}
                    </>
                )}
                {q.dimension !== "session" && (
                    <>
                        <h3>速度与计时覆盖</h3>
                        {member.values.tps?.length ? (
                            member.values.tps.map((t) => (
                                <div
                                    className="call-row"
                                    key={`${t.harness}:${t.kind}`}
                                >
                                    <span>
                                        {t.harness} · {t.kind}
                                        <small>
                                            {t.samples} 个完整计时样本
                                        </small>
                                    </span>
                                    <b>{t.tps?.toFixed(1) ?? "—"} TPS</b>
                                </div>
                            ))
                        ) : (
                            <p className="muted">
                                在相关会话详情中查看各来源计时样本。
                            </p>
                        )}
                    </>
                )}
                <div className="detail-foot">
                    本地日志计量 ·{" "}
                    {shownValues.unpriced ? "费用覆盖部分未知" : "费用为估算值"}
                </div>
            </aside>
        </div>
    );
}
export default function App() {
    const [q, setQ] = useState<Query>(initialQuery),
        [data, setData] = useState<Analysis | null>(null),
        [dataKey, setDataKey] = useState(""),
        [error, setError] = useState(""),
        [loading, setLoading] = useState(true),
        [refreshing, setRefreshing] = useState(false),
        [revision, setRevision] = useState(0),
        [sourcesOpen, setSourcesOpen] = useState(false),
        [moreFilters, setMoreFilters] = useState(false),
        [scanStatus, setScanStatus] = useState<Status | null>(null),
        [selected, setSelected] = useState<string[]>([]),
        [share, setShare] = useState(false),
        [detail, setDetail] = useState<Member | null>(null);
    const queryKey = JSON.stringify(q);
    const current = dataKey === queryKey ? data : null;
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError("");
        analyze(q, controller.signal)
            .then((result) => {
                if (controller.signal.aborted) return;
                setData(result);
                setDataKey(queryKey);
                setLoading(false);
            })
            .catch((e) => {
                if (controller.signal.aborted) return;
                setError(e.message);
                setLoading(false);
            });
        return () => controller.abort();
    }, [queryKey, revision]);
    useEffect(() => {
        setSelected([]);
        setDetail(null);
        if (ratio(q.metric)) setShare(false);
    }, [q.dimension, q.metric]);
    useEffect(() => {
        if (demo) return;
        let active = true;
        (async () => {
            try {
                let latest = await status();
                if (!active) return;
                setScanStatus(latest);
                let wasScanning = latest.scanning;
                while (latest.scanning && active) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    latest = await status();
                    if (active) setScanStatus(latest);
                }
                if (active && wasScanning) {
                    if (latest.error) setError(`扫描失败：${latest.error}`);
                    setRevision((r) => r + 1);
                }
            } catch {
                /* Query handles initial connection failure */
            }
        })();
        return () => {
            active = false;
        };
    }, [revision]);
    function filter(key: FilterKey, values: string[]) {
        setQ({
            ...q,
            filters: { ...q.filters, [key]: values },
            members: undefined,
        });
        setSelected([]);
    }
    function memberFilter(m: Member, sessions = false) {
        if (q.dimension === "session") {
            if (m.harness && m.session_id) {
                setQ({
                    ...q,
                    filters: {
                        ...q.filters,
                        harness: [m.harness],
                        session: [m.session_id],
                    },
                    members: undefined,
                });
                setDetail(null);
                setSelected([]);
            }
            return;
        }
        setQ({
            ...q,
            dimension: sessions ? "session" : q.dimension,
            filters: { ...q.filters, [q.dimension]: [m.key] },
            members: undefined,
        });
        setDetail(null);
        setSelected([]);
    }
    async function scan() {
        setRefreshing(true);
        try {
            let state = await refresh();
            while (state.scanning) {
                await new Promise((resolve) => setTimeout(resolve, 700));
                const latest = await status();
                setScanStatus(latest);
                state = latest;
                if (latest.error) throw new Error(latest.error);
            }
            setRevision((r) => r + 1);
        } catch (e) {
            setError(`扫描失败：${(e as Error).message}`);
        } finally {
            setRefreshing(false);
        }
    }
    return (
        <div className="app-shell">
            {demo && (
                <div className="demo-banner">开发示例数据 · 与本机日志无关</div>
            )}
            <header className="topbar">
                <a className="brand" href="/">
                    <span className="brand-mark">
                        <Icon name="layers" />
                    </span>
                    Usage
                    <span className="brand-divider" />
                    本地用量
                </a>
                <div className="local-indicator">
                    <i />
                    LOCAL · 单机只读
                </div>
            </header>
            <main>
                <div className="page-heading">
                    <div>
                        <span className="eyebrow">PERSONAL ANALYTICS</span>
                        <h1>用量工作台</h1>
                    </div>
                    <div className="heading-actions">
                        <span className="updated">
                            {current?.coverage.updated_at
                                ? `更新于 ${timeLabel(current.coverage.updated_at, q.timezone)}`
                                : "尚未取得快照"}
                        </span>
                        <button onClick={() => setSourcesOpen(!sourcesOpen)}>
                            数据来源
                        </button>
                        <button
                            className="primary"
                            onClick={scan}
                            disabled={refreshing || scanStatus?.scanning}
                        >
                            <span className={refreshing ? "spin" : ""}>
                                <Icon name="refresh" />
                            </span>
                            {refreshing || scanStatus?.scanning
                                ? `扫描 ${scanStatus?.progress.files_done ?? 0}/${scanStatus?.progress.files_total ?? "…"}`
                                : "扫描数据"}
                        </button>
                    </div>
                </div>
                <section className="query-panel">
                    <TimeRange query={q} onChange={setQ} />
                    <div className="filter-line">
                        <span className="filter-label">筛选</span>
                        {filterKeys.map((k) => (
                            <Facet
                                key={k}
                                name={k}
                                options={current?.facets[k] ?? []}
                                selected={q.filters[k] ?? []}
                                onChange={(v) => filter(k, v)}
                            />
                        ))}
                        <button
                            className="text-button"
                            onClick={() => setMoreFilters(!moreFilters)}
                        >
                            更多条件 {moreFilters ? "⌃" : "⌄"}
                        </button>
                        {moreFilters &&
                            (["agent_type", "service_tier"] as FilterKey[]).map(
                                (k) => (
                                    <Facet
                                        key={k}
                                        name={k}
                                        options={current?.facets[k] ?? []}
                                        selected={q.filters[k] ?? []}
                                        onChange={(v) => filter(k, v)}
                                    />
                                ),
                            )}
                        {Object.values(q.filters).some((v) => v?.length) && (
                            <button
                                className="text-button"
                                onClick={() => setQ({ ...q, filters: {} })}
                            >
                                清除筛选
                            </button>
                        )}
                    </div>
                    {Object.entries(q.filters).some(([, v]) => v?.length) && (
                        <div className="chips">
                            {Object.entries(q.filters).flatMap(
                                ([key, values]) =>
                                    (values ?? []).map((v) => (
                                        <button
                                            key={`${key}:${v}`}
                                            onClick={() =>
                                                filter(
                                                    key as FilterKey,
                                                    values!.filter(
                                                        (k) => k !== v,
                                                    ),
                                                )
                                            }
                                        >
                                            {dimensions[key as Dimension]}：
                                            <span>
                                                {current?.facets[
                                                    key as FilterKey
                                                ]?.find((f) => f.key === v)
                                                    ?.label ?? v}
                                            </span>
                                            <Icon name="close" />
                                        </button>
                                    )),
                            )}
                        </div>
                    )}
                </section>
                {sourcesOpen && (
                    <section className="sources panel">
                        <div className="panel-title">
                            <h2>数据来源</h2>
                            <button
                                className="icon-button"
                                onClick={() => setSourcesOpen(false)}
                            >
                                <Icon name="close" />
                            </button>
                        </div>
                        <p className="muted">
                            读取本机日志，扫描只更新本工具的索引。缺失与失败来源分别标注。
                        </p>
                        {(
                            scanStatus?.sources ??
                            current?.coverage.sources ??
                            []
                        ).map((s) => (
                            <article key={s.harness}>
                                <strong>{s.harness}</strong>
                                <span className={`source-state ${s.state}`}>
                                    {
                                        {
                                            ready: "已读取",
                                            missing: "未发现",
                                            error: "读取失败",
                                            partial: "部分可用 · 有覆盖缺口",
                                            scanning: "扫描中",
                                        }[s.state]
                                    }
                                </span>
                                <span>
                                    {formatNumber(s.events)} 条记录 · {s.files}{" "}
                                    个文件
                                </span>
                                {s.warnings.map((w) => (
                                    <small key={w}>{w}</small>
                                ))}
                            </article>
                        ))}
                    </section>
                )}
                {scanStatus?.scanning && (
                    <div className="scan-banner">
                        <span className="spin">
                            <Icon name="refresh" />
                        </span>
                        <div>
                            <strong>
                                正在扫描本机日志 · 当前数字为扫描中的已读小计
                            </strong>
                            <p>
                                {scanStatus.progress.files_done} /{" "}
                                {scanStatus.progress.files_total} 个文件 ·{" "}
                                {formatNumber(scanStatus.progress.events_added)}{" "}
                                条新增记录
                                {scanStatus.progress.current_harness
                                    ? ` · ${scanStatus.progress.current_harness}`
                                    : ""}
                                ；完成后自动更新。
                            </p>
                        </div>
                    </div>
                )}
                {error && (
                    <div className="error-banner">
                        <span>
                            {error}
                            {current ? " · 当前保留上次成功的快照" : ""}
                        </span>
                        <button onClick={() => setRevision((r) => r + 1)}>
                            重试查询
                        </button>
                    </div>
                )}
                {loading && !current && (
                    <div className="loading">
                        <span className="loading-line" />
                        <h2>读取用量快照</h2>
                        <p>首次使用可先扫描本机日志。</p>
                    </div>
                )}
                {current && (
                    <>
                        {current.summary.calls === 0 &&
                            !scanStatus?.scanning && (
                                <div className="notice">
                                    当前时间和筛选条件没有已索引记录。可调整条件；首次使用请扫描本机日志。
                                </div>
                            )}
                        <MetricStrip data={current} />
                        {current.coverage.warnings.length > 0 && (
                            <div className="notice">
                                {current.coverage.warnings.join(" · ")}
                            </div>
                        )}
                        <section className="trend-panel panel">
                            <div className="panel-title trend-heading">
                                <h2>消耗趋势</h2>
                                <div className="metric-switch">
                                    {metrics.map((m) => (
                                        <button
                                            key={m}
                                            className={
                                                q.metric === m ? "selected" : ""
                                            }
                                            onClick={() => {
                                                setQ({
                                                    ...q,
                                                    metric: m,
                                                    members: undefined,
                                                });
                                                setSelected([]);
                                            }}
                                        >
                                            {metricLabels[m]}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="trend-controls">
                                <div className="dimension-tabs">
                                    {Object.entries(dimensions).map(
                                        ([dim, label]) => (
                                            <button
                                                key={dim}
                                                className={
                                                    q.dimension === dim
                                                        ? "selected"
                                                        : ""
                                                }
                                                onClick={() => {
                                                    setQ({
                                                        ...q,
                                                        dimension:
                                                            dim as Dimension,
                                                        members: undefined,
                                                    });
                                                    setSelected([]);
                                                }}
                                            >
                                                {label}
                                            </button>
                                        ),
                                    )}
                                </div>
                                <div className="view-controls">
                                    <select
                                        value={q.bucket}
                                        title="趋势时间粒度"
                                        onChange={(e) =>
                                            setQ({
                                                ...q,
                                                bucket: e.target
                                                    .value as Query["bucket"],
                                            })
                                        }
                                    >
                                        <option value="hour">每小时</option>
                                        <option value="day">每日</option>
                                        <option value="week">每周</option>
                                    </select>
                                    <div className="segmented">
                                        <button
                                            className={!share ? "selected" : ""}
                                            onClick={() => setShare(false)}
                                        >
                                            用量
                                        </button>
                                        <button
                                            disabled={ratio(q.metric)}
                                            title={
                                                ratio(q.metric)
                                                    ? "效率指标不做构成占比"
                                                    : "每桶的成员构成占比"
                                            }
                                            className={share ? "selected" : ""}
                                            onClick={() => setShare(true)}
                                        >
                                            占比
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <Trend
                                data={current}
                                q={q}
                                share={share}
                                selected={selected}
                                onSelect={(keys) => {
                                    setSelected(keys);
                                    setQ({
                                        ...q,
                                        members: keys.length ? keys : undefined,
                                    });
                                }}
                                onZoom={(since, until) => {
                                    setQ({
                                        ...q,
                                        since: new Date(
                                            Math.max(
                                                Date.parse(since),
                                                Date.parse(q.since),
                                            ),
                                        ).toISOString(),
                                        until: new Date(
                                            Math.min(
                                                Date.parse(until),
                                                Date.parse(q.until),
                                            ),
                                        ).toISOString(),
                                        bucket:
                                            q.bucket === "week"
                                                ? "day"
                                                : "hour",
                                        members: undefined,
                                    });
                                    setSelected([]);
                                }}
                            />
                        </section>
                        <Comparison
                            data={current}
                            metric={q.metric}
                            onDetail={setDetail}
                        />
                        <Ledger
                            data={current}
                            q={q}
                            onDetail={setDetail}
                            onFilter={(m) => memberFilter(m)}
                        />
                        <footer>
                            <span>
                                快照 {current.snapshot_id} ·{" "}
                                {current.pricing.label}
                            </span>
                            <span>
                                前窗{" "}
                                {timeLabel(
                                    new Date(
                                        Date.parse(q.since) -
                                            (Date.parse(q.until) -
                                                Date.parse(q.since)),
                                    ).toISOString(),
                                    q.timezone,
                                )}{" "}
                                — {timeLabel(q.since, q.timezone)}
                            </span>
                        </footer>
                    </>
                )}
                {!loading && !current && !error && (
                    <div className="empty">没有可用快照，请扫描数据。</div>
                )}
                {loading && current && (
                    <div className="query-loading">正在更新查询…</div>
                )}
            </main>
            {detail && (
                <Detail
                    member={detail}
                    q={q}
                    onClose={() => setDetail(null)}
                    onFilter={(identity) =>
                        memberFilter(
                            identity ? { ...detail, ...identity } : detail,
                        )
                    }
                    onSessions={() => memberFilter(detail, true)}
                />
            )}
        </div>
    );
}
