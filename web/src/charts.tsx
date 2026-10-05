import { useMemo, useRef, useState } from "react";
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    Brush,
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type { DotItemDotProps } from "recharts";
import type {
    Analysis,
    ChartKind,
    GlobalQuery,
    Metric,
    PanelConfig,
    PanelId,
} from "./types";
import {
    BucketZoom,
    dimensions,
    memberColor,
    ratio,
    value,
} from "./components";
import {
    formatMetric,
    timeLabel,
    metricLabels,
    dateInput,
    intervalLabel,
    timingLabel,
    harnessLabel,
} from "./format";
export type PlotRow = {
    time: string;
    end: string;
    window_start?: string;
    window_end?: string;
    seconds?: number;
    total?: number | null;
    unpriced?: number;
    [key: string]: string | number | null | undefined;
};
export type PlotSeries = {
    id: string;
    key: string;
    label: string;
    color: string;
};
export function TimeChart({
    rows,
    series,
    metric,
    kind,
    share = false,
    stack = false,
    global,
    onZoom,
    id,
}: {
    rows: PlotRow[];
    series: PlotSeries[];
    metric: Metric | string;
    kind: ChartKind;
    share?: boolean;
    stack?: boolean;
    global: GlobalQuery;
    onZoom: (start: string, end: string) => void;
    id: string;
}) {
    // A value separated by unknown neighbours has no segment to draw.
    const isolatedDot = (series: PlotSeries) => (p: DotItemDotProps) => {
        const known = (i: number) =>
            typeof rows[i]?.[series.id] === "number" &&
            Number.isFinite(rows[i]?.[series.id]);
        if (
            !known(p.index) ||
            known(p.index - 1) ||
            known(p.index + 1) ||
            typeof p.cx !== "number" ||
            typeof p.cy !== "number"
        )
            return null;
        return (
            <circle
                className="chart-isolated-point"
                cx={p.cx}
                cy={p.cy}
                r={3}
                fill={series.color}
                stroke="var(--surface)"
                strokeWidth={1}
            />
        );
    };
    const chartElement = useRef<HTMLDivElement>(null);
    const Chart =
        kind === "area" ? AreaChart : kind === "bar" ? BarChart : LineChart;
    const formatter = (n: number | null | undefined) =>
        share
            ? n == null
                ? "—"
                : `${n.toFixed(1)}%`
            : metric in metricLabels
              ? formatMetric(n, metric as Metric)
              : n == null
                ? "—"
                : metric.startsWith("duration")
                  ? `${n.toFixed(1)}s`
                  : new Intl.NumberFormat("en-US", {
                        maximumFractionDigits: 2,
                    }).format(n);
    const tickLabel = (v: string) => {
        const span = Date.parse(global.until) - Date.parse(global.since);
        if (span <= 120000) return dateInput(v, global.timezone).slice(11);
        const label = timeLabel(v, global.timezone);
        return span > 3 * 86400000
            ? label.replace(/\s\d{2}:\d{2}$/, "")
            : label;
    };
    return (
        <div className="dashboard-chart" data-testid={`chart-${id}`}>
            <div className="chart" ref={chartElement}>
                <ResponsiveContainer width="100%" height="100%">
                    <Chart
                        data={rows}
                        margin={{ top: 12, right: 10, bottom: 2, left: 0 }}
                    >
                        <BucketZoom
                            target={chartElement}
                            rows={rows.map((r) => ({
                                time: r.time,
                                end: r.window_end ?? r.end,
                            }))}
                            onZoom={(start, end) => {
                                const row = rows.find((r) => r.time === start);
                                onZoom(
                                    row?.window_start ?? start,
                                    row?.window_end ?? end,
                                );
                            }}
                        />
                        <CartesianGrid
                            vertical={false}
                            stroke="var(--chart-grid)"
                            strokeDasharray="3 5"
                        />
                        <XAxis
                            dataKey="time"
                            axisLine={false}
                            tickLine={false}
                            minTickGap={35}
                            tick={{ fontSize: 10, fill: "var(--muted)" }}
                            tickFormatter={tickLabel}
                        />
                        <YAxis
                            axisLine={false}
                            tickLine={false}
                            width={64}
                            tick={{ fontSize: 10, fill: "var(--muted)" }}
                            tickFormatter={formatter}
                            domain={share ? [0, 100] : [0, "auto"]}
                        />
                        <Tooltip
                            content={({ active, payload, label }) => {
                                if (!active || !payload?.length) return null;
                                const row = rows.find((r) => r.time === label);
                                return (
                                    <div className="chart-tooltip">
                                        <strong>
                                            {dateInput(
                                                String(label),
                                                global.timezone,
                                            ).replace("T", " ")}
                                        </strong>
                                        {series.map((s) => (
                                            <div key={s.id}>
                                                <i
                                                    style={{
                                                        background: s.color,
                                                    }}
                                                />
                                                <span>{s.label}</span>
                                                <b>
                                                    {formatter(
                                                        row?.[s.id] as
                                                            | number
                                                            | null
                                                            | undefined,
                                                    )}
                                                </b>
                                            </div>
                                        ))}
                                        {row?.seconds != null && (
                                            <small>
                                                实际时段{" "}
                                                {row.seconds.toLocaleString(
                                                    "en-US",
                                                )}{" "}
                                                秒
                                            </small>
                                        )}
                                        {metric === "cost" &&
                                            !!row?.unpriced && (
                                                <small>
                                                    已知估算小计 ·{" "}
                                                    {row.unpriced} 次调用缺价
                                                </small>
                                            )}
                                    </div>
                                );
                            }}
                        />
                        {series.map((s) =>
                            kind === "bar" ? (
                                <Bar
                                    key={s.id}
                                    dataKey={s.id}
                                    name={s.label}
                                    fill={s.color}
                                    stackId={stack ? "usage" : undefined}
                                    isAnimationActive={false}
                                />
                            ) : kind === "area" ? (
                                <Area
                                    key={s.id}
                                    dataKey={s.id}
                                    name={s.label}
                                    type="linear"
                                    stroke={s.color}
                                    fill={s.color}
                                    fillOpacity={stack ? 0.32 : 0.1}
                                    stackId={stack ? "usage" : undefined}
                                    connectNulls={false}
                                    dot={isolatedDot(s)}
                                    activeDot={{ r: 3 }}
                                    isAnimationActive={false}
                                />
                            ) : (
                                <Line
                                    key={s.id}
                                    dataKey={s.id}
                                    name={s.label}
                                    type="linear"
                                    stroke={s.color}
                                    strokeWidth={1.8}
                                    connectNulls={false}
                                    dot={isolatedDot(s)}
                                    activeDot={{ r: 3 }}
                                    isAnimationActive={false}
                                />
                            ),
                        )}
                        {rows.length > 1 && (
                            <Brush
                                dataKey="time"
                                height={18}
                                travellerWidth={6}
                                stroke="var(--chart-brush)"
                                fill="var(--surface-soft)"
                                tickFormatter={tickLabel}
                                onDragEnd={(range) => {
                                    const first = range.startIndex ?? 0,
                                        last =
                                            range.endIndex ?? rows.length - 1;
                                    if (first === 0 && last === rows.length - 1)
                                        return;
                                    const a = rows[first],
                                        b = rows[last];
                                    if (a && b)
                                        onZoom(
                                            a.window_start ?? a.time,
                                            b.window_end ?? b.end,
                                        );
                                }}
                            />
                        )}
                    </Chart>
                </ResponsiveContainer>
            </div>
            <div className="chart-legend">
                {series.map((s) => (
                    <span key={s.id} title={s.label}>
                        <i style={{ background: s.color }} />
                        {s.label}
                    </span>
                ))}
            </div>
            {!series.length && (
                <div className="chart-no-series">当前条件没有可用计时样本</div>
            )}
            {rows.length > 0 && (
                <details className="slice-details" data-testid={`slices-${id}`}>
                    <summary>
                        查看时段数值 <span>{rows.length} 个时段</span>
                    </summary>
                    <div className="slice-table">
                        <table>
                            <thead>
                                <tr>
                                    <th>时段开始 · {global.timezone}</th>
                                    <th>实际秒数</th>
                                    {series.map((s) => (
                                        <th key={s.id}>{s.label}</th>
                                    ))}
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr key={r.time}>
                                        <td>
                                            {dateInput(
                                                r.window_start ?? r.time,
                                                global.timezone,
                                            ).replace("T", " ")}
                                        </td>
                                        <td>{r.seconds ?? "—"}</td>
                                        {series.map((s) => (
                                            <td key={s.id}>
                                                {formatter(
                                                    r[s.id] as
                                                        | number
                                                        | null
                                                        | undefined,
                                                )}
                                            </td>
                                        ))}
                                        <td>
                                            <button
                                                onClick={() =>
                                                    onZoom(
                                                        r.window_start ??
                                                            r.time,
                                                        r.window_end ?? r.end,
                                                    )
                                                }
                                            >
                                                查看此时段
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </details>
            )}
        </div>
    );
}
const panelLabels: Record<PanelId, { title: string; metrics: Metric[] }> = {
    consumption: {
        title: "消耗与构成",
        metrics: [
            "cost",
            "tokens",
            "input",
            "output",
            "calls",
            "cost_per_call",
            "cost_per_million",
        ],
    },
    rate: {
        title: "请求强度",
        metrics: ["tpm", "rpm", "throughput_tps", "rps"],
    },
    cache: {
        title: "缓存效率",
        metrics: ["cache_rate", "cache_read", "cache_write"],
    },
    speed: {
        title: "执行速度",
        metrics: ["timed_tps", "throughput_tps", "rps"],
    },
};
export function AnalyticPanel({
    id,
    data,
    config,
    global,
    onConfig,
    onZoom,
}: {
    id: PanelId;
    data: Analysis;
    config: PanelConfig;
    global: GlobalQuery;
    onConfig: (config: PanelConfig) => void;
    onZoom: (start: string, end: string) => void;
}) {
    const [membersOpen, setMembersOpen] = useState(false),
        [memberSearch, setMemberSearch] = useState("");
    const desc = panelLabels[id];
    const timed = data.query.metric === "timed_tps";
    const chartMetric = data.query.metric;
    const plot = useMemo(() => {
        const metadata = timed
            ? (data.timing_members ?? [])
            : (data.series ?? []);
        const series = metadata.map((s, i) => ({
            id: `s${i}`,
            key: s.key,
            label: timed
                ? (() => {
                      const timing = data.timing_members?.find(
                          (t) => t.key === s.key,
                      );
                      return timing
                          ? `${harnessLabel(timing.harness)} · ${timingLabel(timing.kind)}`
                          : s.label;
                  })()
                : s.label,
            color:
                s.key === "__other__"
                    ? "var(--data-other)"
                    : memberColor(data.query.dimension, s.key),
        }));
        const rows = data.trend.map((p) => {
            const row: PlotRow = {
                time: p.start,
                end: p.end,
                window_start: p.window_start,
                window_end: p.window_end,
                seconds: p.seconds,
                total: value(p.total, chartMetric),
                unpriced: p.total.unpriced,
            };
            for (const s of series)
                row[s.id] = timed
                    ? (p.timing?.find((t) => t.key === s.key)?.value ?? null)
                    : config.share
                      ? p.shares?.[s.key] != null
                          ? p.shares[s.key]! * 100
                          : null
                      : p.members[s.key]
                        ? value(p.members[s.key], chartMetric)
                        : null;
            return row;
        });
        return { series, rows };
    }, [data, config.share]);
    const selectedValue = value(data.summary, chartMetric);
    return (
        <section className="analysis-panel panel" data-testid={`panel-${id}`}>
            <header className="analysis-heading">
                <div>
                    <h2>{desc.title}</h2>
                </div>
                <strong className="panel-value" data-testid={`value-${id}`}>
                    {timed
                        ? "按来源计时"
                        : formatMetric(selectedValue, chartMetric)}
                </strong>
            </header>
            <div className="panel-toolbar">
                <div className="quick-metrics">
                    {(
                        {
                            consumption: ["cost", "tokens", "calls"],
                            rate: ["tpm", "rpm"],
                            cache: ["cache_rate", "cache_read"],
                            speed: ["timed_tps", "throughput_tps"],
                        }[id] as Metric[]
                    ).map((m) => (
                        <button
                            key={m}
                            data-testid={`quick-${id}-${m}`}
                            className={config.metric === m ? "selected" : ""}
                            onClick={() =>
                                onConfig({
                                    ...config,
                                    metric: m,
                                    members: [],
                                    share: false,
                                })
                            }
                        >
                            {
                                (
                                    {
                                        cost: "费用",
                                        tokens: "Tokens",
                                        calls: "调用",
                                        tpm: "TPM",
                                        rpm: "RPM",
                                        cache_rate: "命中率",
                                        cache_read: "缓存读取",
                                        timed_tps: "执行 TPS",
                                        throughput_tps: "平均吞吐",
                                    } as Partial<Record<Metric, string>>
                                )[m]
                            }
                        </button>
                    ))}
                </div>
                {!ratio(config.metric) && (
                    <button
                        className={
                            config.share
                                ? "share-toggle selected"
                                : "share-toggle"
                        }
                        data-testid={`share-${id}`}
                        onClick={() =>
                            onConfig({ ...config, share: !config.share })
                        }
                    >
                        {config.share ? "占比 ✓" : "占比"}
                    </button>
                )}
                <details className="panel-menu" data-testid={`settings-${id}`}>
                    <summary>设置 ⌄</summary>
                    <div className="panel-menu-content">
                        {" "}
                        <div className="panel-controls">
                            <label>
                                <span>指标</span>
                                <select
                                    data-testid={`metric-${id}`}
                                    aria-label={`${desc.title}指标`}
                                    value={config.metric}
                                    onChange={(e) =>
                                        onConfig({
                                            ...config,
                                            metric: e.target.value as Metric,
                                            members: [],
                                            share: false,
                                        })
                                    }
                                >
                                    {desc.metrics.map((m) => (
                                        <option value={m} key={m}>
                                            {metricLabels[m]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                <span>分组</span>
                                <select
                                    data-testid={`group-${id}`}
                                    aria-label={`${desc.title}分组`}
                                    disabled={config.metric === "timed_tps"}
                                    value={config.dimension}
                                    onChange={(e) =>
                                        onConfig({
                                            ...config,
                                            dimension: e.target
                                                .value as PanelConfig["dimension"],
                                            members: [],
                                        })
                                    }
                                >
                                    {Object.entries(dimensions)
                                        .filter(([d]) => d !== "session")
                                        .map(([d, l]) => (
                                            <option value={d} key={d}>
                                                {l}
                                            </option>
                                        ))}
                                </select>
                            </label>
                            <label>
                                <span>图形</span>
                                <select
                                    data-testid={`chart-type-${id}`}
                                    aria-label={`${desc.title}图形`}
                                    value={config.chart}
                                    onChange={(e) =>
                                        onConfig({
                                            ...config,
                                            chart: e.target.value as ChartKind,
                                        })
                                    }
                                >
                                    <option value="area">区域</option>
                                    <option value="line">折线</option>
                                    <option value="bar">柱形</option>
                                </select>
                            </label>
                            <div className="panel-actions">
                                {!timed && (
                                    <button
                                        data-testid={`members-${id}`}
                                        onClick={() =>
                                            setMembersOpen(!membersOpen)
                                        }
                                    >
                                        选择对比对象
                                        {config.members.length
                                            ? ` · ${config.members.length}`
                                            : ""}
                                    </button>
                                )}
                            </div>
                        </div>
                        {membersOpen && !timed && (
                            <div className="panel-members">
                                <input
                                    placeholder="搜索本面板成员…"
                                    value={memberSearch}
                                    onChange={(e) =>
                                        setMemberSearch(e.target.value)
                                    }
                                />
                                <span className="muted tiny">
                                    仅改变本图曲线 · 最多 5 项
                                </span>
                                <div>
                                    {data.members
                                        .filter((m) =>
                                            m.label
                                                .toLowerCase()
                                                .includes(
                                                    memberSearch.toLowerCase(),
                                                ),
                                        )
                                        .slice(0, 50)
                                        .map((m) => (
                                            <label key={m.key}>
                                                <input
                                                    type="checkbox"
                                                    checked={config.members.includes(
                                                        m.key,
                                                    )}
                                                    disabled={
                                                        !config.members.includes(
                                                            m.key,
                                                        ) &&
                                                        config.members.length >=
                                                            5
                                                    }
                                                    onChange={() =>
                                                        onConfig({
                                                            ...config,
                                                            members:
                                                                config.members.includes(
                                                                    m.key,
                                                                )
                                                                    ? config.members.filter(
                                                                          (k) =>
                                                                              k !==
                                                                              m.key,
                                                                      )
                                                                    : [
                                                                          ...config.members,
                                                                          m.key,
                                                                      ],
                                                        })
                                                    }
                                                />
                                                <span title={m.tooltip ?? m.label}>
                                                    {m.label}
                                                </span>
                                            </label>
                                        ))}
                                </div>
                                <button
                                    className="text-button"
                                    onClick={() =>
                                        onConfig({ ...config, members: [] })
                                    }
                                >
                                    恢复前 5 名＋其他
                                </button>
                            </div>
                        )}
                    </div>
                </details>
            </div>
            <TimeChart
                id={id}
                {...plot}
                metric={chartMetric}
                kind={config.chart}
                share={config.share}
                stack={
                    !ratio(chartMetric) &&
                    config.chart !== "line" &&
                    !config.members.length
                }
                global={global}
                onZoom={onZoom}
            />
            <footer className="panel-foot">
                <span>
                    {timed
                        ? "按来源与计时类型"
                        : config.share
                          ? config.metric === "cost"
                              ? "费用占比"
                              : "构成占比"
                          : data.query.members?.length
                            ? "所选成员与其他"
                            : "前 5 名＋其他"}{" "}
                    · {timed ? "计时输出" : dimensions[data.query.dimension]} ·{" "}
                    {intervalLabel(data.bucket_resolved ?? global.bucket)}
                </span>
            </footer>
            {timed && data.summary.tps?.length ? (
                <details className="timing-explanation">
                    <summary>查看计时方式与样本</summary>
                    <div className="timing-ledger">
                        {data.summary.tps.map((t) => (
                            <div key={`${t.harness}:${t.kind}`}>
                                <span>
                                    {harnessLabel(t.harness)} ·{" "}
                                    {timingLabel(t.kind)}
                                </span>
                                <b>
                                    {t.tps == null
                                        ? "—"
                                        : `${t.tps.toFixed(1)} TPS`}
                                </b>
                                <small>
                                    {t.samples} 个完整样本 ·{" "}
                                    {t.seconds.toFixed(1)}s
                                </small>
                            </div>
                        ))}
                    </div>
                </details>
            ) : null}
        </section>
    );
}
