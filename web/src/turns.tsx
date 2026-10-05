import { useState } from "react";
import type { ChartKind, GlobalQuery, TurnsAnalysis } from "./types";
import { formatMetric, formatNumber } from "./format";
import { TimeChart, type PlotRow } from "./charts";
import type { TurnView } from "./preferences";
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
export function TurnWorkbench({
    data,
    global,
    onZoom,
    view,
    onView,
}: {
    data: TurnsAnalysis;
    global: GlobalQuery;
    onZoom: (start: string, end: string) => void;
    view: TurnView;
    onView: (view: TurnView) => void;
}) {
    const { chart, metric } = view;
    const [toolsExpanded, setToolsExpanded] = useState(false);
    const metricLabels: Record<string, string> = {
        turns: "轮次开始数",
        tokens: "Tokens",
        cost: "估算费用",
        calls: "模型调用",
        tool_calls: "工具调用",
        tool_calls_known: "工具调用",
        duration_p50: "耗时 P50",
        duration_p95: "耗时 P95",
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
                    <h2>轮次开销与工具使用</h2>
                </div>
            </header>
            <div className="turn-summary">
                <article>
                    <span>Tokens / 轮</span>
                    <b data-testid="tokens-per-turn" title={data.summary.per_turn.tokens_complete_samples !== data.summary.per_turn.samples ? "部分数据" : undefined}>
                        {data.summary.per_turn?.tokens_known_mean == null
                            ? "—"
                            : formatNumber(
                                  data.summary.per_turn.tokens_known_mean,
                              )}
                        {data.summary.per_turn.tokens_known_mean != null && data.summary.per_turn.tokens_complete_samples !== data.summary.per_turn.samples ? "*" : ""}
                    </b>
                </article>
                <article>
                    <span>估算费用 / 轮</span>
                    <b data-testid="cost-per-turn" title={data.summary.per_turn.cost_complete_samples !== data.summary.per_turn.samples ? "部分费用" : undefined}>
                        {formatMetric(
                            data.summary.per_turn?.cost_usd_known_mean,
                            "cost",
                        )}
                        {data.summary.per_turn.cost_usd_known_mean != null && data.summary.per_turn.cost_complete_samples !== data.summary.per_turn.samples ? "*" : ""}
                    </b>
                </article>
                <article>
                    <span>工具调用</span>
                    <b data-testid="tool-call-total" title={data.summary.tool_calls == null ? "部分数据" : undefined}>
                        {formatNumber(data.summary.tool_calls_known)}{data.summary.tool_calls == null ? "*" : ""}
                    </b>
                </article>
                <article>
                    <span>耗时 P50 / P95</span>
                    <b className="duration-value">
                        {sec(data.summary.duration_p50)} /{" "}
                        {sec(data.summary.duration_p95)}
                    </b>
                </article>
            </div>
            <div className="turn-plot-layout">
                <div>
                    <div className="panel-toolbar">
                        <div className="quick-metrics">
                            {["tokens", "cost", "tool_calls_known"].map((m) => (
                                <button
                                    key={m}
                                    data-testid={`quick-turns-${m}`}
                                    className={metric === m ? "selected" : ""}
                                    onClick={() =>
                                        onView({ ...view, metric: m })
                                    }
                                >
                                    {m === "tokens"
                                        ? "Tokens"
                                        : m === "cost"
                                          ? "费用"
                                          : "工具调用"}
                                </button>
                            ))}
                        </div>
                        <details
                            className="panel-menu"
                            data-testid="settings-turns"
                        >
                            <summary>设置 ⌄</summary>
                            <div className="panel-menu-content">
                                {" "}
                                <div className="panel-controls">
                                    <label>
                                        <span>指标</span>
                                        <select
                                            aria-label="轮次趋势指标"
                                            data-testid="metric-turns"
                                            value={metric}
                                            onChange={(e) =>
                                                onView({
                                                    ...view,
                                                    metric: e.target.value,
                                                })
                                            }
                                        >
                                            {Object.entries(metricLabels).map(
                                                ([k, l]) => (
                                                    <option value={k} key={k}>
                                                        {l}
                                                    </option>
                                                ),
                                            )}
                                        </select>
                                    </label>
                                    <label>
                                        <span>图形</span>
                                        <select
                                            aria-label="轮次趋势图形"
                                            data-testid="chart-type-turns"
                                            value={chart}
                                            onChange={(e) =>
                                                onView({
                                                    ...view,
                                                    chart: e.target
                                                        .value as ChartKind,
                                                })
                                            }
                                        >
                                            <option value="area">区域</option>
                                            <option value="line">折线</option>
                                            <option value="bar">柱形</option>
                                        </select>
                                    </label>
                                </div>
                            </div>
                        </details>
                    </div>
                    <TimeChart
                        rows={rows}
                        series={[
                            {
                                id: "v",
                                key: metric,
                                label: metricLabels[metric],
                                color: "var(--data-teal)",
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
                        工具类型与状态<span title={data.tools.coverage !== "complete" ? "部分数据" : undefined}>{data.tools.rows.length} 类{data.tools.coverage !== "complete" ? "*" : ""}</span>
                    </div>
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
                        <p className="muted tiny">没有工具调用</p>
                    )}
                </aside>
            </div>
        </section>
    );
}
