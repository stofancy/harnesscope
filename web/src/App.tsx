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
import { demo, refresh, status, type Status } from "./api";
import {
    Comparison,
    Detail,
    Facet,
    Icon,
    Ledger,
    MetricStrip,
    dimensions,
} from "./components";
import { AnalyticPanel } from "./charts";
import { TurnDrawer, TurnWorkbench, TurnTable } from "./turns";
import {
    formatNumber,
    metricLabels,
    timeLabel,
    intervalLabel,
    formatMetric,
} from "./format";
import { useDashboard } from "./useDashboard";
import { readPreferences, savePreferences, type TurnView } from "./preferences";
import { AbsoluteRanking } from "./ranking";
import { TimeControl } from "./TimeControl";
import { advanceTime, type TimeSpec } from "./time";
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
export default function App() {
    const [saved] = useState(readPreferences);
    const [global, setGlobalState] = useState<GlobalQuery>(saved.global),
        [timeSpec, setTimeSpec] = useState<TimeSpec>(saved.timeSpec),
        [autoSeconds, setAutoSeconds] = useState(saved.autoSeconds),
        [timeEditing, setTimeEditing] = useState(false),
        [configs, setConfigs] = useState(saved.panels),
        [detailView, setDetailView] = useState(saved.detailView),
        [turnView, setTurnView] = useState<TurnView>(saved.turnView),
        [ledgerConfig, setLedgerConfig] = useState<{
            dimension: Dimension;
            metric: Metric;
        }>(saved.ledger),
        [turnOffset, setTurnOffset] = useState(0),
        [error, setError] = useState(""),
        [revision, setRevision] = useState(0),
        [scanStatus, setScanStatus] = useState<Status | null>(null),
        [refreshing, setRefreshing] = useState(false),
        [moreFilters, setMoreFilters] = useState(false),
        [sourcesOpen, setSourcesOpen] = useState(false),
        [helpOpen, setHelpOpen] = useState(false),
        [history, setHistory] = useState<
            { since: string; until: string; timeSpec: TimeSpec }[]
        >(saved.history),
        [selectedMember, setSelectedMember] = useState<Member | null>(null),
        [selectedTurn, setSelectedTurn] = useState<TurnRow | null>(null),
        [navigationTarget, setNavigationTarget] = useState<string | null>(null);
    const globalRef = useRef(global);
    globalRef.current = global;
    function setGlobal(update: React.SetStateAction<GlobalQuery>) {
        const next =
            typeof update === "function" ? update(globalRef.current) : update;
        if (JSON.stringify(next) !== JSON.stringify(globalRef.current))
            setTurnOffset(0);
        globalRef.current = next;
        setGlobalState(next);
    }
    const timeSpecRef = useRef(timeSpec),
        refreshRef = useRef(false),
        editingRef = useRef(timeEditing);
    timeSpecRef.current = timeSpec;
    editingRef.current = timeEditing;
    function advanceRelativeWindow() {
        setGlobal((q) => advanceTime(q, timeSpecRef.current));
    }
    const globalKey = JSON.stringify(global);
    const { data, pending, errors, globalUpdating, retry } = useDashboard(
        global,
        configs,
        ledgerConfig,
        turnOffset,
        turnView,
        revision,
    );
    const loading = pending.length > 0;
    const current = data;
    const persistedKey = JSON.stringify({
        global,
        timeSpec,
        autoSeconds,
        panels: configs,
        ledger: ledgerConfig,
        detailView,
        turnView,
        history,
    });
    useEffect(
        () =>
            savePreferences({
                global,
                timeSpec,
                autoSeconds,
                panels: configs,
                ledger: ledgerConfig,
                detailView,
                turnView,
                history,
            }),
        [persistedKey],
    );
    useEffect(() => {
        setSelectedMember(null);
        setSelectedTurn(null);
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
    }, []);
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
            ...history.slice(-15),
            { since: global.since, until: global.until, timeSpec },
        ]);
        setTimeSpec({ start, end });
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
            setTimeSpec(previous.timeSpec);
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
        if (sessionView) {
            setLedgerConfig({ ...ledgerConfig, dimension: "session" });
            setDetailView("summary");
            setNavigationTarget("details");
        }
        setSelectedMember(null);
    }
    async function scan() {
        if (refreshRef.current || scanStatus?.scanning) return;
        refreshRef.current = true;
        setError("");
        setRefreshing(true);
        try {
            let state = await refresh();
            let polled = false;
            while (state.scanning) {
                polled = true;
                await new Promise((resolve) => setTimeout(resolve, 700));
                const latest = await status();
                setScanStatus(latest);
                state = latest;
                if (latest.error) throw new Error(latest.error);
            }
            if (!polled) setScanStatus(await status());
            advanceRelativeWindow();
            setRevision((r) => r + 1);
        } catch (e) {
            setError(`扫描失败：${(e as Error).message}`);
        } finally {
            refreshRef.current = false;
            setRefreshing(false);
        }
    }
    const scanRef = useRef(scan),
        queryBusyRef = useRef(loading);
    scanRef.current = scan;
    queryBusyRef.current = loading;
    useEffect(() => {
        if (!autoSeconds) return;
        const timer = setInterval(() => {
            if (
                !document.hidden &&
                !editingRef.current &&
                !refreshRef.current &&
                !queryBusyRef.current
            )
                void scanRef.current();
        }, autoSeconds * 1000);
        return () => clearInterval(timer);
    }, [autoSeconds]);
    const counts = current?.panels.consumption;
    return (
        <div className="app-shell dashboard-shell">
            {demo && (
                <div className="demo-banner">开发示例数据 · 与本机日志无关</div>
            )}
            <main>
                <header className="workbench-header">
                    <h1>用量工作台</h1>
                    <nav
                        className="workbench-nav"
                        data-testid="journey-nav"
                        aria-label="工作台导航"
                    >
                        <a href="#overview">概览</a>
                        <a href="#trends">趋势</a>
                        <a
                            href="#details"
                            onClick={() => setDetailView("turns")}
                        >
                            轮次
                        </a>
                        <a
                            href="#details"
                            onClick={() => setDetailView("summary")}
                        >
                            汇总
                        </a>
                    </nav>
                    <div className="heading-actions">
                        <span className="updated">
                            {scanStatus?.updated_at
                                ? `更新于 ${timeLabel(scanStatus.updated_at, global.timezone)}`
                                : ""}
                        </span>
                        <button
                            data-testid="open-metric-help"
                            onClick={() => setHelpOpen(true)}
                        >
                            指标说明
                        </button>
                        <button onClick={() => setSourcesOpen(!sourcesOpen)}>
                            数据来源
                        </button>
                        <button
                            className="primary"
                            data-testid="scan-data"
                            onClick={scan}
                            disabled={refreshing || scanStatus?.scanning}
                        >
                            <Icon name="refresh" />
                            {refreshing || scanStatus?.scanning
                                ? `扫描 ${scanStatus?.progress.files_done ?? 0}/${scanStatus?.progress.files_total ?? "…"}`
                                : "扫描数据"}
                        </button>
                    </div>
                </header>
                <section
                    className="query-panel global-query"
                    data-testid="global-query"
                >
                    <div className="global-query-heading">
                        <span className="scope-label">
                            <Icon name="filter" />
                            筛选
                        </span>
                        <span className="global-snapshot">
                            {current && !globalUpdating
                                ? timeSpec.end === "now"
                                    ? "至今"
                                    : "固定时段"
                                : "正在查询当前范围"}
                        </span>
                    </div>
                    <div className="global-time-line">
                        <TimeControl
                            global={global}
                            spec={timeSpec}
                            onEditing={setTimeEditing}
                            onChange={(spec, range) => {
                                setTimeSpec(spec);
                                setGlobal({ ...global, ...range });
                                setHistory([]);
                            }}
                        />
                        <select
                            data-testid="timezone"
                            title="全局时区"
                            aria-label="全局时区"
                            value={global.timezone}
                            onChange={(e) =>
                                setGlobal({
                                    ...global,
                                    timezone: e.target.value,
                                })
                            }
                        >
                            {[
                                ...new Set([
                                    global.timezone,
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
                        <label className="slice-label">
                            <span>统计间隔</span>
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
                        <label className="auto-refresh-label">
                            自动刷新
                            <select
                                data-testid="auto-refresh"
                                aria-label="自动刷新频率"
                                value={autoSeconds}
                                onChange={(e) =>
                                    setAutoSeconds(Number(e.target.value))
                                }
                            >
                                <option value="0">关闭</option>
                                <option value="15">15 秒</option>
                                <option value="30">30 秒</option>
                                <option value="60">1 分钟</option>
                                <option value="300">5 分钟</option>
                            </select>
                        </label>
                        {history.length > 0 && (
                            <button
                                data-testid="zoom-back"
                                className="zoom-back"
                                onClick={back}
                            >
                                ← 返回原时间范围
                            </button>
                        )}
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
                {(error || errors.global) && (
                    <div className="error-banner" data-testid="dashboard-error">
                        <span>
                            {error || errors.global}
                            {current ? " · 暂时显示上次查询结果" : ""}
                        </span>
                        <button onClick={() => retry()}>重试查询</button>
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
                    <div
                        className={
                            globalUpdating
                                ? "data-region is-updating"
                                : "data-region"
                        }
                        inert={globalUpdating}
                        aria-busy={globalUpdating}
                    >
                        <section id="overview" className="overview-section">
                            <MetricStrip
                                data={counts}
                                turnCount={current.turns.summary.turns}
                            />
                        </section>
                        <div id="trends" className="primary-analysis">
                            <PartState
                                pending={pending.includes("consumption")}
                                error={errors.consumption}
                                onRetry={() => retry("consumption")}
                            >
                                <AnalyticPanel
                                    id="consumption"
                                    data={current.panels.consumption}
                                    config={configs.consumption}
                                    global={current.global}
                                    onConfig={(c) =>
                                        setConfigs({
                                            ...configs,
                                            consumption: c,
                                        })
                                    }
                                    onZoom={zoom}
                                />
                            </PartState>
                            <PartState
                                pending={pending.includes("consumption")}
                                error={errors.consumption}
                                onRetry={() => retry("consumption")}
                            >
                                <AbsoluteRanking
                                    data={current.panels.consumption}
                                    config={configs.consumption}
                                    onConfig={(c) =>
                                        setConfigs({
                                            ...configs,
                                            consumption: c,
                                        })
                                    }
                                    onSelect={(m) => {
                                        changeFilter(
                                            current.panels.consumption.query
                                                .dimension,
                                            [m.key],
                                        );
                                        setDetailView("turns");
                                        setNavigationTarget("details");
                                    }}
                                />
                            </PartState>
                        </div>
                        <details id="contributors" className="change-details">
                            <summary>较上一等长时段的变化</summary>
                            <Comparison
                                data={current.panels.consumption}
                                metric={current.panels.consumption.query.metric}
                                onDetail={(m) => {
                                    changeFilter(
                                        current.panels.consumption.query
                                            .dimension,
                                        [m.key],
                                    );
                                    setDetailView("turns");
                                    setNavigationTarget("details");
                                }}
                            />
                        </details>
                        <div className="supporting-analysis">
                            {(["rate", "cache", "speed"] as PanelId[]).map(
                                (id) => (
                                    <PartState
                                        key={id}
                                        pending={pending.includes(id)}
                                        error={errors[id]}
                                        onRetry={() => retry(id)}
                                    >
                                        <AnalyticPanel
                                            id={id}
                                            data={current.panels[id]}
                                            config={configs[id]}
                                            global={current.global}
                                            onConfig={(c) =>
                                                setConfigs({
                                                    ...configs,
                                                    [id]: c,
                                                })
                                            }
                                            onZoom={zoom}
                                        />
                                    </PartState>
                                ),
                            )}
                        </div>
                        <PartState
                            pending={pending.includes("turns")}
                            error={errors.turns}
                            onRetry={() => retry("turns")}
                        >
                            <TurnWorkbench
                                data={current.turns}
                                global={current.global}
                                onZoom={zoom}
                                view={turnView}
                                onView={setTurnView}
                            />
                        </PartState>
                        <section id="details" className="details-section">
                            <div
                                className="detail-tabs"
                                role="tablist"
                                aria-label="数据明细"
                            >
                                <button
                                    role="tab"
                                    aria-selected={detailView === "summary"}
                                    data-testid="detail-tab-summary"
                                    onClick={() => setDetailView("summary")}
                                >
                                    汇总明细
                                </button>
                                <button
                                    role="tab"
                                    aria-selected={detailView === "turns"}
                                    data-testid="detail-tab-turns"
                                    onClick={() => setDetailView("turns")}
                                >
                                    轮次明细
                                </button>
                            </div>
                            {detailView === "turns" ? (
                                <PartState
                                    pending={pending.includes("turns")}
                                    error={errors.turns}
                                    onRetry={() => retry("turns")}
                                >
                                    <TurnTable
                                        data={current.turns}
                                        global={current.global}
                                        view={turnView}
                                        onPage={setTurnOffset}
                                        onOpen={setSelectedTurn}
                                        onSort={(sort, order) => {
                                            setTurnView({
                                                ...turnView,
                                                sort,
                                                order,
                                            });
                                            setTurnOffset(0);
                                        }}
                                    />
                                </PartState>
                            ) : (
                                <PartState
                                    pending={pending.includes("ledger")}
                                    error={errors.ledger}
                                    onRetry={() => retry("ledger")}
                                >
                                    <div id="ledger" className="ledger-angle">
                                        <div>
                                            <h2>汇总明细</h2>
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
                                                        <option
                                                            value={k}
                                                            key={k}
                                                        >
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
                                                        metric: e.target
                                                            .value as Metric,
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
                                    </div>
                                    <Ledger
                                        data={current.ledger}
                                        q={current.ledger.query}
                                        onDetail={setSelectedMember}
                                        onFilter={(m) => filterMember(m)}
                                    />
                                </PartState>
                            )}
                        </section>
                        <footer className="dashboard-footer">
                            <span>USD</span>
                            <span>
                                图表按
                                {intervalLabel(
                                    current.panels.consumption
                                        .bucket_resolved ?? global.bucket,
                                )}
                                汇总 · {global.timezone}
                            </span>
                        </footer>
                    </div>
                )}
                {globalUpdating && current && (
                    <div
                        className="query-loading"
                        data-testid="dashboard-updating"
                    >
                        {errors.global
                            ? "查询未完成，图表仍为上次范围"
                            : "正在更新当前范围 · 图表暂为上次结果"}
                    </div>
                )}
            </main>
            {helpOpen && (
                <div
                    className="modal-backdrop"
                    onClick={() => setHelpOpen(false)}
                >
                    <section
                        className="time-dialog metric-help"
                        role="dialog"
                        aria-label="指标说明"
                        data-testid="metric-help"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="panel-title">
                            <h2>指标说明</h2>
                            <button
                                className="icon-button"
                                aria-label="关闭指标说明"
                                onClick={() => setHelpOpen(false)}
                            >
                                <Icon name="close" />
                            </button>
                        </div>
                        <dl>
                            <dt>费用</dt>
                            <dd>
                                按公开或自定义价格估算，单位
                                USD。缺价调用不计入费用小计。
                            </dd>
                            <dt>Tokens 与调用</dt>
                            <dd>
                                来自本地日志。字段缺失显示
                                —；来源读取情况见“数据来源”。
                            </dd>
                            <dt>TPM / RPM · 每秒吞吐 / RPS</dt>
                            <dd>
                                用量或调用数除以所选时段实际长度，包含空闲时间。
                            </dd>
                            <dt>缓存命中率</dt>
                            <dd>
                                缓存读取占全部输入 Tokens
                                的比例，缓存写入计入输入。
                            </dd>
                            <dt>执行输出速度</dt>
                            <dd>
                                输出 Tokens
                                除以计时样本耗时。模型响应与包含工具等待的轮次全程分别统计。
                            </dd>
                            <dt>每轮已记录均值</dt>
                            <dd>
                                使用完全落在所选时段内、已结束且有记录的轮次，取已知小计均值；价格或输入组成覆盖不足会标“部分”。
                            </dd>
                            <dt>时间与自动刷新</dt>
                            <dd>
                                相对范围如 -18h、-2days
                                以及固定起点至今，在刷新后更新至当下。固定历史范围保持不动。自动刷新增量扫描后读取看板，后台或编辑时间时暂停。
                            </dd>
                        </dl>
                    </section>
                </div>
            )}
            {selectedMember && current && !globalUpdating && (
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
            {selectedTurn && current && !globalUpdating && (
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

function PartState({
    pending,
    error,
    onRetry,
    children,
}: {
    pending: boolean;
    error?: string;
    onRetry: () => void;
    children: React.ReactNode;
}) {
    return (
        <div
            className={`part-state ${pending || error ? "part-stale" : ""}`}
            aria-busy={pending}
        >
            {(pending || error) && (
                <div className="part-status">
                    {pending ? "正在更新此面板…" : `未能更新 · ${error}`}
                    {error && <button onClick={onRetry}>重试此面板</button>}
                </div>
            )}
            <div inert={pending || !!error}>{children}</div>
        </div>
    );
}
