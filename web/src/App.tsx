import { useEffect, useState, useRef } from "react";
import type {
    Dimension,
    FilterKey,
    GlobalQuery,
    Member,
    Metric,
    PanelConfig,
    PanelId,
    Query,
    TurnRow,
} from "./types";
import {
    dashboard,
    demo,
    refresh,
    status,
    type Dashboard,
    type Status,
} from "./api";
import {
    Comparison,
    Detail,
    Facet,
    Icon,
    Ledger,
    MetricStrip,
    TimeRange,
    dimensions,
} from "./components";
import { AnalyticPanel } from "./charts";
import { TurnDrawer, TurnWorkbench } from "./turns";
import { formatNumber, metricLabels, timeLabel, intervalLabel } from "./format";
const mainFilters: FilterKey[] = [
    "harness",
    "model",
    "project",
    "provider",
    "purpose",
];
const extraFilters: FilterKey[] = ["agent_type", "service_tier", "session"];
const slices: { key: GlobalQuery["bucket"]; label: string }[] = [
    { key: "auto", label: "自动" },
    { key: "second", label: "每秒" },
    { key: "10second", label: "10 秒" },
    { key: "minute", label: "1 分钟" },
    { key: "5minute", label: "5 分钟" },
    { key: "15minute", label: "15 分钟" },
    { key: "hour", label: "1 小时" },
    { key: "day", label: "1 天" },
    { key: "week", label: "1 周" },
    { key: "month", label: "1 月" },
];
function initialGlobal(): GlobalQuery {
    const end = new Date();
    return {
        since: new Date(end.getTime() - 7 * 86400000).toISOString(),
        until: end.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        bucket: "auto",
        filters: {},
    };
}
const initialPanels: Record<PanelId, PanelConfig> = {
    consumption: {
        dimension: "model",
        metric: "cost",
        chart: "area",
        share: false,
        members: [],
    },
    rate: {
        dimension: "harness",
        metric: "tpm",
        chart: "line",
        share: false,
        members: [],
    },
    cache: {
        dimension: "model",
        metric: "cache_rate",
        chart: "line",
        share: false,
        members: [],
    },
    speed: {
        dimension: "harness",
        metric: "timed_tps",
        chart: "line",
        share: false,
        members: [],
    },
};
export default function App() {
    const [global, setGlobal] = useState<GlobalQuery>(initialGlobal),
        [relativeDays, setRelativeDays] = useState<number | null>(7),
        [configs, setConfigs] = useState(initialPanels),
        [ledgerConfig, setLedgerConfig] = useState<{
            dimension: Dimension;
            metric: Metric;
        }>({ dimension: "harness", metric: "cost" }),
        [turnOffset, setTurnOffset] = useState(0),
        [data, setData] = useState<Dashboard | null>(null),
        [error, setError] = useState(""),
        [loading, setLoading] = useState(true),
        [revision, setRevision] = useState(0),
        [scanStatus, setScanStatus] = useState<Status | null>(null),
        [refreshing, setRefreshing] = useState(false),
        [moreFilters, setMoreFilters] = useState(false),
        [sourcesOpen, setSourcesOpen] = useState(false),
        [history, setHistory] = useState<
            { since: string; until: string; relativeDays: number | null }[]
        >([]),
        [selectedMember, setSelectedMember] = useState<Member | null>(null),
        [selectedTurn, setSelectedTurn] = useState<TurnRow | null>(null),
        [navigationTarget, setNavigationTarget] = useState<string | null>(null);
    const relativeDaysRef = useRef(relativeDays);
    relativeDaysRef.current = relativeDays;
    function advanceRelativeWindow() {
        const days = relativeDaysRef.current;
        if (days == null) return;
        const now = new Date();
        setGlobal((q) => ({
            ...q,
            since: new Date(now.getTime() - days * 86400000).toISOString(),
            until: now.toISOString(),
        }));
    }
    const globalKey = JSON.stringify(global);
    const localKey = JSON.stringify({
        panels: Object.fromEntries(
            Object.entries(configs).map(([k, c]) => [
                k,
                {
                    dimension: c.dimension,
                    metric: c.metric,
                    members: c.members,
                },
            ]),
        ),
        ledgerConfig,
        turnOffset,
    });
    const current =
        data && JSON.stringify(data.global) === globalKey ? data : null;
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError("");
        dashboard(global, configs, ledgerConfig, turnOffset, controller.signal)
            .then((result) => {
                if (!controller.signal.aborted) {
                    setData(result);
                    setLoading(false);
                }
            })
            .catch((e) => {
                if (!controller.signal.aborted) {
                    setError(e.message);
                    setLoading(false);
                }
            });
        return () => controller.abort();
    }, [globalKey, localKey, revision]);
    useEffect(() => {
        setSelectedMember(null);
        setSelectedTurn(null);
        setTurnOffset(0);
    }, [globalKey]);
    useEffect(() => {
        if (demo) return;
        let active = true;
        (async () => {
            try {
                let latest = await status();
                if (!active) return;
                setScanStatus(latest);
                const wasScanning = latest.scanning;
                while (latest.scanning && active) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    latest = await status();
                    if (active) setScanStatus(latest);
                }
                if (active && wasScanning) {
                    if (!latest.error) advanceRelativeWindow();
                    if (latest.error) setError(`扫描失败：${latest.error}`);
                    setRevision((r) => r + 1);
                }
            } catch {
                /* The dashboard request displays connection errors. */
            }
        })();
        return () => {
            active = false;
        };
    }, [revision]);
    useEffect(() => {
        if (navigationTarget && current && !loading) {
            document
                .getElementById(navigationTarget)
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            setNavigationTarget(null);
        }
    }, [navigationTarget, current, loading]);
    function changeFilter(key: FilterKey, values: string[]) {
        setGlobal({ ...global, filters: { ...global.filters, [key]: values } });
        setConfigs(
            Object.fromEntries(
                Object.entries(configs).map(([k, c]) => [
                    k,
                    { ...c, members: [] as string[] },
                ]),
            ) as Record<PanelId, PanelConfig>,
        );
    }
    function zoom(since: string, until: string) {
        const start = new Date(
                Math.max(Date.parse(since), Date.parse(global.since)),
            ).toISOString(),
            end = new Date(
                Math.min(Date.parse(until), Date.parse(global.until)),
            ).toISOString();
        if (start >= end || (start === global.since && end === global.until))
            return;
        setHistory([
            ...history,
            { since: global.since, until: global.until, relativeDays },
        ]);
        setRelativeDays(null);
        setGlobal({ ...global, since: start, until: end });
    }
    function back() {
        const previous = history.at(-1);
        if (previous) {
            setGlobal({
                ...global,
                since: previous.since,
                until: previous.until,
            });
            setRelativeDays(previous.relativeDays);
            setHistory(history.slice(0, -1));
        }
    }
    function filterMember(
        member: Member,
        sessionView = false,
        identity?: { harness: string; session_id: string },
    ) {
        const dimension =
            current?.ledger.query.dimension ?? ledgerConfig.dimension;
        if (dimension === "session") {
            const harness = identity?.harness ?? member.harness,
                id = identity?.session_id ?? member.session_id;
            if (harness && id)
                setGlobal({
                    ...global,
                    filters: {
                        ...global.filters,
                        harness: [harness],
                        session: [id],
                    },
                });
        } else changeFilter(dimension, [member.key]);
        if (sessionView)
            setLedgerConfig({ ...ledgerConfig, dimension: "session" });
        setSelectedMember(null);
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
            advanceRelativeWindow();
            setRevision((r) => r + 1);
        } catch (e) {
            setError(`扫描失败：${(e as Error).message}`);
        } finally {
            setRefreshing(false);
        }
    }
    const queryForTime: Query = {
        ...global,
        dimension: "harness",
        metric: "tokens",
    };
    const counts = current?.panels.consumption;
    return (
        <div className="app-shell dashboard-shell">
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
                            {scanStatus?.updated_at
                                ? `数据扫描于 ${timeLabel(scanStatus.updated_at, global.timezone)}`
                                : "尚未取得扫描状态"}
                        </span>
                        <button onClick={() => setSourcesOpen(!sourcesOpen)}>
                            数据来源
                        </button>
                        <button
                            className="primary"
                            data-testid="scan-data"
                            onClick={scan}
                            disabled={refreshing || scanStatus?.scanning}
                        >
                            <span
                                className={
                                    refreshing || scanStatus?.scanning
                                        ? "spin"
                                        : ""
                                }
                            >
                                <Icon name="refresh" />
                            </span>
                            {refreshing || scanStatus?.scanning
                                ? `扫描 ${scanStatus?.progress.files_done ?? 0}/${scanStatus?.progress.files_total ?? "…"}`
                                : "扫描数据"}
                        </button>
                    </div>
                </div>
                <nav
                    className="journey-nav"
                    data-testid="journey-nav"
                    aria-label="用量分析路径"
                >
                    <a href="#overview">
                        <b>1</b> 概览 <span>本期用了多少</span>
                    </a>
                    <a href="#trends">
                        <b>2</b> 趋势 <span>找到异常时段</span>
                    </a>
                    <a href="#contributors">
                        <b>3</b> 对象 <span>比较变化来源</span>
                    </a>
                    <a href="#turns">
                        <b>4</b> 轮次 <span>查看消耗与工具</span>
                    </a>
                    <a href="#ledger">明细</a>
                    {history.length > 0 && (
                        <button
                            data-testid="zoom-back"
                            className="zoom-back"
                            onClick={back}
                        >
                            ← 恢复放大前的时间范围
                        </button>
                    )}
                    {(history.length > 0 ||
                        Object.values(global.filters).some(
                            (v) => v?.length,
                        )) && (
                        <div className="journey-context">
                            当前查看 {timeLabel(global.since, global.timezone)}{" "}
                            — {timeLabel(global.until, global.timezone)}
                            {Object.entries(global.filters)
                                .filter(([, v]) => v?.length)
                                .map(([k, v]) => (
                                    <span key={k}>
                                        {dimensions[k as Dimension]}：
                                        {v!
                                            .map(
                                                (value) =>
                                                    counts?.facets[
                                                        k as FilterKey
                                                    ]?.find(
                                                        (f) => f.key === value,
                                                    )?.label ?? value,
                                            )
                                            .join("、")}
                                    </span>
                                ))}
                        </div>
                    )}
                </nav>
                <section
                    className="query-panel global-query"
                    data-testid="global-query"
                >
                    <div className="global-query-heading">
                        <span className="scope-label">
                            <Icon name="filter" />
                            分析范围 · 所有图表与明细共同使用
                        </span>
                        <span className="global-snapshot">
                            {current
                                ? relativeDays
                                    ? "最近时段 · 扫描后更新至当下"
                                    : "固定时段 · 扫描后保留范围"
                                : "正在查询当前范围"}
                        </span>
                    </div>
                    <div className="global-time-line">
                        <TimeRange
                            query={queryForTime}
                            relativeDays={relativeDays}
                            onChange={(q, mode) => {
                                if (mode !== undefined) setRelativeDays(mode);
                                setGlobal({
                                    since: q.since,
                                    until: q.until,
                                    timezone: q.timezone,
                                    bucket: q.bucket,
                                    filters: q.filters,
                                });
                                setHistory([]);
                            }}
                        />
                        <label className="slice-label">
                            <span>图中每个点代表</span>
                            <select
                                data-testid="time-slice"
                                aria-label="全局统计间隔"
                                value={global.bucket}
                                onChange={(e) =>
                                    setGlobal({
                                        ...global,
                                        bucket: e.target
                                            .value as GlobalQuery["bucket"],
                                    })
                                }
                            >
                                {slices.map((s) => (
                                    <option value={s.key} key={s.key}>
                                        {s.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    <div className="filter-line">
                        <span className="filter-label">筛选数据</span>
                        {mainFilters.map((k) => (
                            <Facet
                                key={k}
                                name={k}
                                options={counts?.facets[k] ?? []}
                                selected={global.filters[k] ?? []}
                                onChange={(v) => changeFilter(k, v)}
                            />
                        ))}
                        <button
                            className="text-button"
                            data-testid="more-filters"
                            onClick={() => setMoreFilters(!moreFilters)}
                        >
                            更多条件 {moreFilters ? "⌃" : "⌄"}
                        </button>
                        {moreFilters &&
                            extraFilters.map((k) => (
                                <Facet
                                    key={k}
                                    name={k}
                                    options={counts?.facets[k] ?? []}
                                    selected={global.filters[k] ?? []}
                                    onChange={(v) => changeFilter(k, v)}
                                />
                            ))}
                        {Object.values(global.filters).some(
                            (v) => v?.length,
                        ) && (
                            <button
                                className="text-button"
                                data-testid="clear-filters"
                                onClick={() => {
                                    setGlobal({ ...global, filters: {} });
                                    setConfigs(
                                        Object.fromEntries(
                                            Object.entries(configs).map(
                                                ([k, c]) => [
                                                    k,
                                                    {
                                                        ...c,
                                                        members: [] as string[],
                                                    },
                                                ],
                                            ),
                                        ) as Record<PanelId, PanelConfig>,
                                    );
                                }}
                            >
                                清除筛选
                            </button>
                        )}
                    </div>
                    {Object.entries(global.filters).some(
                        ([, v]) => v?.length,
                    ) && (
                        <div className="chips">
                            {Object.entries(global.filters).flatMap(
                                ([key, values]) =>
                                    (values ?? []).map((v) => (
                                        <button
                                            key={`${key}:${v}`}
                                            onClick={() =>
                                                changeFilter(
                                                    key as FilterKey,
                                                    values!.filter(
                                                        (k) => k !== v,
                                                    ),
                                                )
                                            }
                                        >
                                            {dimensions[key as Dimension]}：
                                            <span>
                                                {counts?.facets[
                                                    key as FilterKey
                                                ]?.find((f) => f.key === v)
                                                    ?.label ??
                                                    (v || "未知归属")}
                                            </span>
                                            <Icon name="close" />
                                        </button>
                                    )),
                            )}
                        </div>
                    )}
                </section>
                {sourcesOpen && (
                    <section id="sources" className="sources panel">
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
                            扫描读取本机日志并更新本工具索引；缺失与读取失败分别标注。
                        </p>
                        {(
                            scanStatus?.sources ??
                            counts?.coverage.sources ??
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
                            <strong>正在扫描 · 当前可用数字为已读小计</strong>
                            <p>
                                {scanStatus.progress.files_done} /{" "}
                                {scanStatus.progress.files_total} 个文件 ·{" "}
                                {formatNumber(scanStatus.progress.events_added)}{" "}
                                条新增记录；完成后自动更新。
                            </p>
                        </div>
                    </div>
                )}
                {error && (
                    <div className="error-banner" data-testid="dashboard-error">
                        <span>
                            {error}
                            {current ? " · 暂时显示上次查询结果" : ""}
                        </span>
                        <button onClick={() => setRevision((r) => r + 1)}>
                            重试查询
                        </button>
                    </div>
                )}
                {!current && loading && (
                    <div className="loading" data-testid="dashboard-loading">
                        <span className="loading-line" />
                        <h2>正在读取本期用量</h2>
                        <p>将根据当前时间范围与筛选条件，更新图表和明细。</p>
                    </div>
                )}
                {current && counts && (
                    <>
                        <section id="overview" className="overview-section">
                            <div className="section-heading">
                                <div>
                                    <span className="eyebrow">本期用量</span>
                                    <h2>选定期间，花了多少、用了多少</h2>
                                </div>
                                <span
                                    className={`coverage-pill ${counts.summary.unpriced || scanStatus?.scanning ? "partial" : ""}`}
                                >
                                    {scanStatus?.scanning
                                        ? "正在扫描 · 数字尚未齐备"
                                        : counts.summary.unpriced
                                          ? "费用仅含已知部分"
                                          : counts.summary.calls
                                            ? "已记录调用均有价格"
                                            : "当前范围没有调用记录"}
                                </span>
                            </div>
                            <MetricStrip data={counts} />
                            <details
                                className="coverage-explanation"
                                data-testid="coverage-explanation"
                            >
                                <summary>
                                    {counts.summary.unpriced
                                        ? `${formatNumber(counts.summary.unpriced)} 次调用缺价`
                                        : "费用按公开 / 自定义价目估算"}
                                    {counts.coverage.sources.some(
                                        (s) =>
                                            s.state === "partial" ||
                                            s.state === "error",
                                    )
                                        ? " · 来源有记录缺口"
                                        : " · 仅统计本地已记录用量"}{" "}
                                    <span>查看统计说明</span>
                                </summary>
                                <p>
                                    费用为估算，真实账单未知。Tokens
                                    与调用仅包含已读取记录；未记录的调用无法由本地日志证明。没有价格或完整计时记录时显示
                                    —。
                                </p>
                                {counts.coverage.warnings.map((w) => (
                                    <p key={w}>{w}</p>
                                ))}
                                <button
                                    className="text-button"
                                    onClick={() => {
                                        setSourcesOpen(true);
                                        setNavigationTarget("sources");
                                    }}
                                >
                                    查看各来源状态
                                </button>
                            </details>
                        </section>
                        <div id="trends" className="section-heading">
                            <div>
                                <span className="eyebrow">找时段</span>
                                <h2>从趋势里找到用量峰值</h2>
                            </div>
                            <p>
                                点击异常时段，或拖动图下方选区；所有图表与明细会一起缩小范围。
                            </p>
                        </div>
                        <div className="dashboard-grid">
                            {(
                                [
                                    "consumption",
                                    "rate",
                                    "cache",
                                    "speed",
                                ] as PanelId[]
                            ).map((id) => (
                                <AnalyticPanel
                                    key={id}
                                    id={id}
                                    data={current.panels[id]}
                                    config={configs[id]}
                                    global={current.global}
                                    onConfig={(c) =>
                                        setConfigs({ ...configs, [id]: c })
                                    }
                                    onZoom={zoom}
                                />
                            ))}
                        </div>
                        <section
                            id="contributors"
                            className="contributor-section"
                        >
                            <div className="section-heading">
                                <div>
                                    <span className="eyebrow">找对象</span>
                                    <h2>哪些对象推动了变化</h2>
                                </div>
                                <div className="angle-shortcuts">
                                    {(
                                        [
                                            "model",
                                            "harness",
                                            "project",
                                        ] as Dimension[]
                                    ).map((d) => (
                                        <button
                                            key={d}
                                            className={
                                                configs.consumption
                                                    .dimension === d
                                                    ? "selected"
                                                    : ""
                                            }
                                            onClick={() =>
                                                setConfigs({
                                                    ...configs,
                                                    consumption: {
                                                        ...configs.consumption,
                                                        dimension: d,
                                                        members: [],
                                                    },
                                                })
                                            }
                                        >
                                            按{dimensions[d]}对比
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <p className="section-description">
                                比较消耗图当前指标与上一等长时间范围。选择一个对象，继续查看它的轮次与工具调用。
                            </p>
                            <Comparison
                                data={current.panels.consumption}
                                metric={current.panels.consumption.query.metric}
                                onDetail={(m) => {
                                    setLedgerConfig({
                                        dimension:
                                            current.panels.consumption.query
                                                .dimension,
                                        metric: current.panels.consumption.query
                                            .metric,
                                    });
                                    changeFilter(
                                        current.panels.consumption.query
                                            .dimension,
                                        [m.key],
                                    );
                                    setNavigationTarget("turns");
                                }}
                            />
                        </section>
                        <TurnWorkbench
                            data={current.turns}
                            global={current.global}
                            onZoom={zoom}
                            onPage={setTurnOffset}
                            onOpen={setSelectedTurn}
                        />
                        <div id="ledger" className="ledger-angle">
                            <div>
                                <span className="eyebrow">EVENT LEDGER</span>
                                <h2>调用用量账本</h2>
                            </div>
                            <label>
                                分组查看
                                <select
                                    data-testid="group-ledger"
                                    aria-label="用量账本分组"
                                    value={ledgerConfig.dimension}
                                    onChange={(e) =>
                                        setLedgerConfig({
                                            ...ledgerConfig,
                                            dimension: e.target
                                                .value as Dimension,
                                        })
                                    }
                                >
                                    {Object.entries(dimensions).map(
                                        ([k, l]) => (
                                            <option value={k} key={k}>
                                                {l}
                                            </option>
                                        ),
                                    )}
                                </select>
                            </label>
                            <label>
                                主要指标
                                <select
                                    data-testid="metric-ledger"
                                    aria-label="用量账本主要指标"
                                    value={ledgerConfig.metric}
                                    onChange={(e) =>
                                        setLedgerConfig({
                                            ...ledgerConfig,
                                            metric: e.target.value as Metric,
                                        })
                                    }
                                >
                                    {(
                                        [
                                            "cost",
                                            "tokens",
                                            "calls",
                                            "cache_rate",
                                            "cost_per_call",
                                            "cost_per_million",
                                        ] as Metric[]
                                    ).map((m) => (
                                        <option key={m} value={m}>
                                            {metricLabels[m]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <span className="scope-label">
                                同一全局分析范围
                            </span>
                        </div>
                        <Ledger
                            data={current.ledger}
                            q={current.ledger.query}
                            onDetail={setSelectedMember}
                            onFilter={(m) => filterMember(m)}
                        />
                        <footer className="dashboard-footer">
                            <span>
                                本地已记录用量 · 公开 / 自定义价目估算 · USD
                            </span>
                            <span>
                                图表按
                                {intervalLabel(
                                    current.panels.consumption
                                        .bucket_resolved ?? global.bucket,
                                )}
                                汇总 · {global.timezone}
                            </span>
                        </footer>
                    </>
                )}
                {loading && current && (
                    <div
                        className="query-loading"
                        data-testid="dashboard-updating"
                    >
                        正在更新图表与明细…
                    </div>
                )}
            </main>
            {selectedMember && current && (
                <Detail
                    member={selectedMember}
                    q={current.ledger.query}
                    onClose={() => setSelectedMember(null)}
                    onFilter={(identity) =>
                        filterMember(selectedMember, false, identity)
                    }
                    onSessions={() => filterMember(selectedMember, true)}
                />
            )}{" "}
            {selectedTurn && current && (
                <TurnDrawer
                    row={selectedTurn}
                    global={current.global}
                    snapshot={current.snapshot_id}
                    onClose={() => setSelectedTurn(null)}
                />
            )}
        </div>
    );
}
