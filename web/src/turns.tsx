import { useEffect, useState } from "react";
import type {
    ChartKind,
    GlobalQuery,
    TurnDetail,
    TurnRow,
    TurnsAnalysis,
} from "./types";
import { turnDetail } from "./api";
import { Icon } from "./components";
import {
    formatMetric,
    formatNumber,
    timeLabel,
    boundaryLabel,
    harnessLabel,
} from "./format";
import { TimeChart, type PlotRow } from "./charts";
const statuses: Record<string, string> = {
    completed: "完成",
    success: "成功",
    failed: "失败",
    failure: "失败",
    error: "错误",
    running: "进行中",
    in_progress: "进行中",
    cancelled: "取消",
    interrupted: "中断",
    unknown: "未知",
    truncated: "截断",
};
const stateLabel = (s: string) => statuses[s] ?? s;
const sec = (n: number | null | undefined) =>
    n == null ? "—" : `${n.toFixed(1)}s`;
const rowMetrics = (r: TurnRow) => r.window_metrics;
export function TurnWorkbench({
    data,
    global,
    onZoom,
    onPage,
    onOpen,
}: {
    data: TurnsAnalysis;
    global: GlobalQuery;
    onZoom: (start: string, end: string) => void;
    onPage: (offset: number) => void;
    onOpen: (r: TurnRow) => void;
}) {
    const [chart, setChart] = useState<ChartKind>("bar"),
        [metric, setMetric] = useState("tokens"),
        [toolsExpanded, setToolsExpanded] = useState(false);
    const metricLabels: Record<string, string> = {
        turns: "轮次开始数",
        tokens: "窗内 Tokens",
        cost: "窗内估算费用",
        calls: "已记录模型调用",
        tool_calls: "工具调用",
        tool_calls_known: "已记录工具小计",
        duration_p50: "完整轮次 P50 耗时",
        duration_p95: "完整轮次 P95 耗时",
    };
    const rows: PlotRow[] = data.trend.map((p) => ({
        time: p.start,
        end: p.end,
        window_start: p.window_start,
        window_end: p.window_end,
        seconds: p.seconds,
        total: metric === "cost" ? p.metrics.cost : null,
        unpriced: p.metrics.unpriced,
        v:
            metric === "cost"
                ? p.metrics.cost
                : metric === "tokens"
                  ? p.metrics.tokens
                  : metric === "calls"
                    ? p.metrics.calls
                    : metric === "turns"
                      ? p.turns
                      : metric === "tool_calls"
                        ? p.tool_calls
                        : metric === "tool_calls_known"
                          ? p.tool_calls_known
                          : metric === "duration_p50"
                            ? p.duration_p50
                            : p.duration_p95,
    }));
    return (
        <section
            id="turns"
            className="turn-workbench panel"
            data-testid="panel-turns"
        >
            <header className="analysis-heading">
                <div>
                    <span className="panel-index">05</span>
                    <h2>轮次开销与工具使用</h2>
                </div>
            </header>
            <div className="turn-summary">
                <article>
                    <span>已选轮次</span>
                    <b data-testid="turn-count">
                        {formatNumber(data.summary.turns)}
                    </b>
                    <small>
                        {Object.entries(data.summary.status_counts)
                            .map(([s, n]) => `${stateLabel(s)} ${n}`)
                            .join(" · ")}
                    </small>
                </article>
                <article>
                    <span>平均 Tokens / 轮</span>
                    <b>
                        {data.summary.per_turn?.tokens == null
                            ? "—"
                            : formatNumber(data.summary.per_turn.tokens)}
                    </b>
                    <small>
                        {data.summary.per_turn?.samples ?? 0}{" "}
                        轮样本
                        {data.summary.per_turn?.boundary_quality?.inferred
                            ? ` · ${data.summary.per_turn.boundary_quality.inferred} 个推定边界`
                            : ""}
                    </small>
                </article>
                <article>
                    <span>平均费用 / 轮</span>
                    <b>
                        {formatMetric(data.summary.per_turn?.cost_usd, "cost")}
                    </b>

                </article>
                <article>
                    <span>工具调用</span>
                    <b data-testid="tool-call-total">
                        {data.summary.tool_calls == null
                            ? "—"
                            : formatNumber(data.summary.tool_calls)}
                    </b>
                    <small>
                        已记录小计 {data.summary.tool_calls_known} · 每轮{" "}
                        {data.summary.tools_per_turn?.toFixed(1) ?? "—"}
                    </small>
                </article>
                <article>
                    <span>轮次耗时 P50 / P95</span>
                    <b className="duration-value">
                        {sec(data.summary.duration_p50)} /{" "}
                        {sec(data.summary.duration_p95)}
                    </b>
                    <small>
                        {data.summary.duration_samples} 个样本
                        {data.summary.duration_boundary_quality
                            ? ` · ${data.summary.duration_boundary_quality.inferred ?? 0} 个推定边界`
                            : ""}
                    </small>
                </article>
            </div>
            <div className="turn-plot-layout">
                <div>
                    <div className="panel-controls">
                        <label>
                            <span>指标</span>
                            <select
                                aria-label="轮次趋势指标"
                                data-testid="metric-turns"
                                value={metric}
                                onChange={(e) => setMetric(e.target.value)}
                            >
                                {Object.entries(metricLabels).map(([k, l]) => (
                                    <option value={k} key={k}>
                                        {l}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            <span>图形</span>
                            <select
                                aria-label="轮次趋势图形"
                                data-testid="chart-type-turns"
                                value={chart}
                                onChange={(e) =>
                                    setChart(e.target.value as ChartKind)
                                }
                            >
                                <option value="area">区域</option>
                                <option value="line">折线</option>
                                <option value="bar">柱形</option>
                            </select>
                        </label>
                        <span className="scope-label">
                            点击时段或拖动底部选区，查看局部
                        </span>
                    </div>
                    <TimeChart
                        rows={rows}
                        series={[
                            {
                                id: "v",
                                key: metric,
                                label: metricLabels[metric],
                                color: "#26766a",
                            },
                        ]}
                        metric={metric}
                        kind={chart}
                        global={global}
                        onZoom={onZoom}
                        id="turns"
                    />
                </div>
                <aside className="tools-panel" data-testid="tools-summary">
                    <div className="member-title">
                        工具类型与状态<span>{data.tools.rows.length} 类</span>
                    </div>
                    {data.tools.coverage !== "complete" && <span className="muted tiny" title="部分轮次的工具记录缺失，以下显示已读取的调用。">部分记录</span>}
                    <div className="tool-status-total">
                        {Object.entries(data.tools.status_counts).map(
                            ([s, n]) => (
                                <span key={s}>
                                    {stateLabel(s)} <b>{n}</b>
                                </span>
                            ),
                        )}
                    </div>
                    {[...data.tools.rows]
                        .sort((a, b) => b.calls - a.calls)
                        .slice(0, toolsExpanded ? undefined : 6)
                        .map((tool) => (
                            <article className="tool-stat" key={tool.tool_name}>
                                <strong>{tool.tool_name}</strong>
                                <b>{tool.calls}</b>
                                <small>
                                    {Object.entries(tool.status_counts)
                                        .map(
                                            ([s, n]) => `${stateLabel(s)} ${n}`,
                                        )
                                        .join(" · ")}
                                    {tool.duration_samples > 0
                                        ? ` · P50 ${sec(tool.duration_p50)}`
                                        : ""}
                                </small>
                            </article>
                        ))}
                    {data.tools.rows.length > 6 && (
                        <button
                            className="text-button tool-expand"
                            data-testid="expand-tools"
                            onClick={() => setToolsExpanded(!toolsExpanded)}
                        >
                            {toolsExpanded
                                ? "收起排行"
                                : `查看全部 ${data.tools.rows.length} 类工具`}
                        </button>
                    )}
                    {!data.tools.rows.length && (
                        <p className="muted tiny">当前窗没有已记录工具调用</p>
                    )}
                </aside>
            </div>
            <div className="turn-table-heading">
                <h3>轮次明细</h3>
            </div>
            <div className="table-scroll">
                <table className="turn-table">
                    <thead>
                        <tr>
                            <th className="name-col">轮次 / 来源</th>
                            <th>状态与覆盖</th>
                            <th>Tokens</th>
                            <th>估算费用</th>
                            <th>已记录模型调用</th>
                            <th>工具调用</th>
                            <th>整轮耗时</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.rows.map((r) => (
                            <tr key={r.key}>
                                <td>
                                    <button
                                        className="row-name"
                                        data-testid="turn-row"
                                        onClick={() => onOpen(r)}
                                        title={`${r.harness} / ${r.session_id} / ${r.turn_id}`}
                                    >
                                        <span>{r.turn_id}</span>
                                        <Icon name="arrow" />
                                    </button>
                                    <small className="row-subtitle">
                                        {harnessLabel(r.harness)} ·{" "}
                                        {timeLabel(
                                            r.start,
                                            global.timezone,
                                            true,
                                        )}
                                    </small>
                                </td>
                                <td>
                                    <span
                                        className={`status-badge ${r.status}`}
                                    >
                                        {stateLabel(r.status)}
                                    </span>
                                    <small className="table-quality">
                                        {boundaryLabel(r.boundary_quality)} ·{" "}
                                        {r.recorded_usage_available
                                            ? "整轮已记录小计"
                                            : r.full_window
                                              ? "已记录组成未知"
                                              : "窗口截断 / 进行中"}
                                    </small>
                                </td>
                                <td>{formatNumber(rowMetrics(r).tokens)}</td>
                                <td>
                                    {formatMetric(rowMetrics(r).cost, "cost")}
                                    {rowMetrics(r).unpriced > 0 ? " *" : ""}
                                </td>
                                <td>{rowMetrics(r).calls}</td>
                                <td>
                                    {r.tool_calls ?? "—"}
                                    {r.tool_calls == null && (
                                        <small className="table-quality">
                                            已记录 {r.tool_calls_known}
                                        </small>
                                    )}
                                </td>
                                <td>{sec(r.duration_seconds)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {!data.rows.length && (
                    <p className="empty">当前时间与筛选条件没有已选轮次</p>
                )}
            </div>
            <div className="table-bottom">
                <span>
                    截断轮次 {data.coverage.truncated_turns} · 未归属调用{" "}
                    {data.coverage.unassigned_calls} ·{" "}
                    {data.coverage.usage_scope === "filtered_calls"
                        ? "已筛选调用范围"
                        : "所有已记录调用范围"}
                </span>
                <div>
                    <button
                        data-testid="turn-prev"
                        disabled={data.offset === 0}
                        onClick={() =>
                            onPage(Math.max(0, data.offset - data.limit))
                        }
                    >
                        上一页
                    </button>
                    <span>
                        {Math.floor(data.offset / data.limit) + 1} /{" "}
                        {Math.max(1, Math.ceil(data.total / data.limit))}
                    </span>
                    <button
                        data-testid="turn-next"
                        disabled={data.offset + data.limit >= data.total}
                        onClick={() => onPage(data.offset + data.limit)}
                    >
                        下一页
                    </button>
                </div>
            </div>
        </section>
    );
}
export function TurnDrawer({
    row,
    global,
    snapshot,
    onClose,
}: {
    row: TurnRow;
    global: GlobalQuery;
    snapshot: string;
    onClose: () => void;
}) {
    const [detail, setDetail] = useState<TurnDetail | null>(null),
        [error, setError] = useState("");
    useEffect(() => {
        const c = new AbortController();
        turnDetail(global, row, c.signal)
            .then((r) => {
                if (!c.signal.aborted) setDetail(r);
            })
            .catch((e) => {
                if (!c.signal.aborted) setError(e.message);
            });
        return () => c.abort();
    }, [row.key, JSON.stringify(global)]);
    const value = detail?.window_metrics ?? row.window_metrics;
    return (
        <div className="drawer-backdrop" onClick={onClose}>
            <aside
                className="drawer turn-drawer"
                data-testid="turn-detail"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="panel-title">
                    <span className="eyebrow">轮次详情 · {row.harness}</span>
                    <button
                        className="text-button"
                        title="关闭轮次详情"
                        onClick={onClose}
                    >
                        ← 返回轮次列表
                    </button>
                </div>
                <h2 className="detail-name">{row.turn_id}</h2>
                <p className="muted">
                    会话 {row.session_id}
                    <br />
                    {timeLabel(row.start, global.timezone, true)} —{" "}
                    {row.end
                        ? timeLabel(row.end, global.timezone, true)
                        : "尚未结束"}{" "}
                    · {stateLabel(row.status)}
                </p>
                {detail && detail.snapshot_id !== snapshot && (
                    <p className="notice">
                        数据刚完成更新，详情展示最新已记录用量；关闭后可刷新工作台。
                    </p>
                )}
                <div className="detail-metrics">
                    <div>
                        <span>窗内 Tokens</span>
                        <strong>{formatNumber(value.tokens)}</strong>
                    </div>
                    <div>
                        <span>窗内估算费用</span>
                        <strong>{formatMetric(value.cost, "cost")}</strong>
                    </div>
                    <div>
                        <span>窗内已记录模型调用</span>
                        <strong>{value.calls}</strong>
                    </div>
                    <div>
                        <span>整轮耗时</span>
                        <strong>{sec(row.duration_seconds)}</strong>
                    </div>
                    <div>
                        <span>工具调用</span>
                        <strong>{row.tool_calls ?? "—"}</strong>
                    </div>
                    <div>
                        <span>已记录工具小计</span>
                        <strong>{row.tool_calls_known}</strong>
                    </div>
                </div>
                <details className="detail-coverage">
                    <summary>数据覆盖与统计范围</summary>
                    <p className="notice">
                        {row.recorded_usage_available
                            ? "整轮已记录小计可用"
                            : "当前仅展示已记录小计或窗口截断"}{" "}
                        · {boundaryLabel(row.boundary_quality)} ·{" "}
                        {row.tool_coverage === "complete"
                            ? "工具记录完整"
                            : "工具结果或数量有缺失"}
                        {value.unpriced > 0
                            ? ` · ${value.unpriced} 条调用缺价`
                            : ""}
                    </p>
                </details>
                {error && <p className="error-text">{error}</p>}
                {!detail && !error && (
                    <p className="muted">正在读取轮次调用…</p>
                )}
                {detail && (
                    <>
                        <h3>整轮已记录小计</h3>
                        <p className="muted tiny">
                            Tokens{" "}
                            {formatNumber(detail.recorded_metrics.tokens)} ·
                            费用{" "}
                            {formatMetric(detail.recorded_metrics.cost, "cost")}{" "}
                            · 调用 {detail.recorded_metrics.calls}；
                            {detail.usage_scope === "filtered_calls"
                                ? "保持全局模型等条件筛选"
                                : "所有已记录调用"}

                        </p>
                        <h3>模型调用</h3>
                        {detail.calls.map((c) => (
                            <article
                                className="call-row"
                                data-testid="turn-model-call"
                                key={c.key}
                            >
                                <span>
                                    {c.model}
                                    <small>
                                        {timeLabel(
                                            new Date(
                                                c.timestamp_us / 1000,
                                            ).toISOString(),
                                            global.timezone,
                                        )}{" "}
                                        · {c.in_window ? "窗内" : "窗外"} ·{" "}
                                        {c.quality}
                                    </small>
                                </span>
                                <span className="call-numbers">
                                    <b>
                                        {formatNumber(
                                            c.input_net +
                                                c.cache_read +
                                                (c.cache_write ?? 0) +
                                                c.output,
                                        )}{" "}
                                        Tokens
                                    </b>
                                    <b>{formatMetric(c.cost_usd, "cost")}</b>
                                    <small>
                                        {c.cache_write == null
                                            ? "输入组成有缺失"
                                            : "已记录小计"}
                                    </small>
                                </span>
                            </article>
                        ))}
                        <h3>工具调用与结果</h3>
                        {detail.tools.map((t) => (
                            <article
                                className="call-row"
                                data-testid="turn-tool-call"
                                key={t.key}
                            >
                                <span>
                                    {t.tool_name}
                                    <small>
                                        {timeLabel(
                                            new Date(
                                                t.start_us / 1000,
                                            ).toISOString(),
                                            global.timezone,
                                        )}{" "}
                                        · {t.in_window ? "窗内" : "窗外"} ·{" "}
                                        {sec(t.duration_seconds)}
                                    </small>
                                </span>
                                <span className={`status-badge ${t.status}`}>
                                    {stateLabel(t.status)}
                                </span>
                            </article>
                        ))}
                        {!detail.tools.length && (
                            <p className="muted tiny">
                                没有已记录工具调用；覆盖 {row.tool_coverage}。
                            </p>
                        )}
                        {detail.related_turns.length > 0 && (
                            <>
                                <h3>有依据的关联轮次</h3>
                                {detail.related_turns.map((r) => (
                                    <p
                                        className="muted tiny"
                                        key={`${r.harness}:${r.session_id}:${r.turn_id}`}
                                    >
                                        {r.relationship ?? "关联"} · {r.harness}{" "}
                                        / {r.turn_id}
                                    </p>
                                ))}
                            </>
                        )}
                    </>
                )}
            </aside>
        </div>
    );
}
