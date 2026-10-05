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
    timingLabel,
    harnessLabel,
    formatMetric,
    formatNumber,
    inputDate,
    metricLabels,
    timeLabel,
} from "./format";
const dimensions: Record<Dimension, string> = {
    harness: "来源",
    model: "模型",
    project: "项目",
    provider: "Provider",
    purpose: "用途",
    agent_type: "代理类型",
    service_tier: "服务档位",
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
function MetricStrip({
    data,
    turnCount,
}: {
    data: Analysis;
    turnCount?: number;
}) {
    return (
        <section className="metric-strip" data-testid="summary">
            {(["cost", "tokens", "calls"] as Metric[]).map((m) => (
                <article key={m}>
                    <div className="metric-label">
                        {m === "calls" ? "模型调用" : metricLabels[m]}
                    </div>
                    <div className="metric-value" data-testid={`summary-${m}`}>
                        {formatMetric(value(data.summary, m), m)}
                    </div>
                    <div className="metric-foot">
                        <span>
                            {m === "cost"
                                ? data.summary.unpriced
                                    ? `部分价格 · ${formatNumber(data.summary.unpriced)} 次缺价`
                                    : "USD"
                                : m === "tokens"
                                  ? `${data.summary.input_complete === false ? "已记录 · " : ""}输入 ${formatNumber(data.summary.input)} / 输出 ${formatNumber(data.summary.output)}`
                                  : `${formatNumber(data.summary.sessions)} 个会话`}
                        </span>
                        <span className="change">
                            {displayedChange(
                                data.changes?.[m],
                                value(data.summary, m),
                                value(data.previous_summary, m),
                            )}
                            <small> 较前期</small>
                        </span>
                    </div>
                </article>
            ))}
            <article>
                <div className="metric-label">轮次</div>
                <div className="metric-value" data-testid="turn-count">
                    {turnCount == null ? "—" : formatNumber(turnCount)}
                </div>
                <div className="metric-foot">
                    <span>与当前范围相交</span>
                </div>
            </article>
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
                {knownMode && (
                    <small title="部分调用缺少价格，变化仅对应已计价部分。">
                        部分费用
                    </small>
                )}
            </div>
            <div className="contributions">
                {changes.map(({ m, delta }) => (
                    <button
                        key={m.key}
                        title={`筛选${m.label}并查看其轮次`}
                        onClick={() => onDetail(m)}
                    >
                        <span title={m.label}>{m.label}</span>
                        <b className={delta! > 0 ? "increase" : "decrease"}>
                            {delta! > 0 ? "+" : "−"}
                            {formatMetric(Math.abs(delta!), metric)}
                        </b>
                        <small>查看轮次 ↗</small>
                    </button>
                ))}
                {!changes.length && (
                    <span className="muted">
                        {metric === "cost" &&
                        data.knownCostChange?.absolute != null
                            ? `已知小计变化 ${data.knownCostChange.absolute >= 0 ? "+" : "−"}${formatMetric(Math.abs(data.knownCostChange.absolute), "cost")}`
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
        <section className="ledger panel" data-testid="ledger">
            <div className="panel-title">
                <div>
                    <h2>
                        用量明细 <span>{rows.length} 项</span>
                    </h2>
                    <p className="muted tiny">
                        按{dimensions[q.dimension]}比较 ·
                        点击名称查看详情，右侧筛选可联动所有面板
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
                        className="text-button"
                        title="关闭详情"
                        onClick={onClose}
                    >
                        ← 返回用量明细
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
                                        {harnessLabel(t.harness)} ·{" "}
                                        {timingLabel(t.kind)}
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
                                        {harnessLabel(t.harness)} ·{" "}
                                        {timingLabel(t.kind)}
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

export {
    Icon,
    Facet,
    MetricStrip,
    BucketZoom,
    Comparison,
    Ledger,
    Detail,
    dimensions,
    memberColor,
    ratio,
    value,
};
