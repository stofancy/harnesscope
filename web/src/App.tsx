import { useEffect, useRef, useState } from "react";
import type {
    Dimension,
    FilterKey,
    GlobalQuery,
    Member,
    PanelId,
    PanelConfig,
    UsageDrill,
} from "./types";
import { demo, refresh, status, type Status } from "./api";
import {
    Comparison,
    Facet,
    Icon,
    Ledger,
    MetricStrip,
    dimensions,
} from "./components";
import { AnalyticPanel } from "./charts";
import { TurnWorkbench } from "./turns";
import { AbsoluteRanking } from "./ranking";
import { TimeControl } from "./TimeControl";
import { advanceTime, type TimeSpec } from "./time";
import { readPreferences, savePreferences } from "./preferences";
import { useDashboard } from "./useDashboard";
import { useUsage, UsageTable } from "./Usage";
import { dateInput, harnessLabel, timeLabel } from "./format";
const filters: FilterKey[] = [
    "harness",
    "model",
    "project",
    "provider",
    "purpose",
];
const extra: FilterKey[] = ["agent_type", "service_tier", "session"];
const slices: {
    key: GlobalQuery["bucket"];
    label: string;
    seconds?: number;
}[] = [
    { key: "auto", label: "自动" },
    { key: "second", label: "1 秒", seconds: 1 },
    { key: "5second", label: "5 秒", seconds: 5 },
    { key: "10second", label: "10 秒", seconds: 10 },
    { key: "30second", label: "30 秒", seconds: 30 },
    { key: "minute", label: "1 分", seconds: 60 },
    { key: "5minute", label: "5 分", seconds: 300 },
    { key: "15minute", label: "15 分", seconds: 900 },
    { key: "hour", label: "1 时", seconds: 3600 },
    { key: "day", label: "1 天" },
    { key: "week", label: "1 周" },
    { key: "month", label: "1 月" },
];
function buckets(q: GlobalQuery, seconds: number) {
    const t = Date.parse(q.since),
        end = Date.parse(q.until);
    const local = dateInput(q.since, q.timezone);
    const minute = Number(local.slice(14, 16)),
        second = Number(local.slice(17, 19)),
        fraction = ((t % 1000) + 1000) % 1000;
    const remainder =
        seconds >= 60
            ? (minute % (seconds / 60)) * 60 + second
            : second % seconds;
    return Math.ceil(
        (end - t + remainder * 1000 + fraction) / (seconds * 1000),
    );
}
function pointCount(q: GlobalQuery, choice: (typeof slices)[number]) {
    if (choice.key === "auto") return 0;
    if (choice.seconds) return buckets(q, choice.seconds);
    const cursor = new Date(q.since);
    cursor.setHours(0, 0, 0, 0);
    if (choice.key === "week")
        cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
    if (choice.key === "month") cursor.setDate(1);
    let count = 0;
    while (cursor.getTime() < Date.parse(q.until) && count <= 2000) {
        count++;
        if (choice.key === "month") cursor.setMonth(cursor.getMonth() + 1);
        else cursor.setDate(cursor.getDate() + (choice.key === "week" ? 7 : 1));
    }
    return count;
}
export default function App() {
    const [saved] = useState(readPreferences),
        [global, setGlobalState] = useState(saved.global),
        [timeSpec, setTimeSpec] = useState(saved.timeSpec),
        [configs, setConfigs] = useState(saved.panels),
        [turnView, setTurnView] = useState(saved.turnView),
        [history, setHistory] = useState(saved.history),
        [page, setPage] = useState(saved.page),
        [theme, setTheme] = useState(saved.theme),
        [autoSeconds, setAutoSeconds] = useState(saved.autoSeconds),
        [autoPeriod, setAutoPeriod] = useState(saved.autoPeriod),
        [usageView, setUsageView] = useState(saved.usageView),
        [drill, setDrill] = useState<UsageDrill | null>(null),
        [drillBack, setDrillBack] = useState(saved.usageView),
        [more, setMore] = useState(false),
        [revision, setRevision] = useState(0),
        [scanStatus, setScanStatus] = useState<Status | null>(null),
        [refreshing, setRefreshing] = useState(false),
        [error, setError] = useState(""),
        [editing, setEditing] = useState(false),
        [snapshot, setSnapshot] = useState<string | null>(null);
    function setGlobal(update: React.SetStateAction<GlobalQuery>) {
        setGlobalState((previous) => {
            const next =
                typeof update === "function" ? update(previous) : update;
            const choice = slices.find((s) => s.key === next.bucket);
            return choice && pointCount(next, choice) > 2000
                ? { ...next, bucket: "auto" }
                : next;
        });
    }
    const d = useDashboard(
            global,
            configs,
            revision,
            page === "dashboard",
            snapshot,
        ),
        u = useUsage(global, usageView, drill, revision, page === "usage");
    const busy = page === "dashboard" ? d.pending.length > 0 : u.pending;
    const current = d.data,
        counts = current?.panels.consumption,
        facets = page === "dashboard" ? counts?.facets : u.data?.facets;
    const refs = useRef({ global, timeSpec, editing, busy, scanStatus });
    const liveRange = timeSpec.end === "now";
    refs.current = { global, timeSpec, editing, busy, scanStatus };
    const refreshLock = useRef(false);
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
    }, [theme]);
    useEffect(() => {
        if (page === "dashboard" && current && !d.globalUpdating)
            setSnapshot(current.snapshot_id);
        if (page === "usage" && u.data && !u.pending)
            setSnapshot(u.data.snapshot_id);
    }, [page, current, u.data, d.globalUpdating, u.pending]);
    useEffect(() => {
        if (page !== "usage" || u.pending || !u.data) return;
        const lastOffset = Math.max(
            0,
            (Math.ceil(u.data.total / usageView.limit) - 1) * usageView.limit,
        );
        if (usageView.offset > lastOffset)
            setUsageView((v) => ({ ...v, offset: lastOffset }));
    }, [page, u.pending, u.data, usageView.offset, usageView.limit]);
    const prefs = {
        ...saved,
        global,
        timeSpec,
        panels: configs,
        turnView,
        history,
        page,
        theme,
        autoSeconds,
        autoPeriod,
        usageView,
    };
    useEffect(() => savePreferences(prefs), [JSON.stringify(prefs)]);
    const previousGlobal = useRef(JSON.stringify(global));
    useEffect(() => {
        const key = JSON.stringify(global);
        if (previousGlobal.current === key) return;
        previousGlobal.current = key;
        setUsageView((v) => ({ ...v, offset: 0 }));
        setDrill(null);
    }, [JSON.stringify(global)]);
    function updateTime(
        spec: TimeSpec,
        range: { since: string; until: string },
    ) {
        setTimeSpec(spec);
        setGlobal((g) => ({ ...g, ...range }));
        setHistory([]);
    }
    function changeFilter(key: FilterKey, values: string[]) {
        setGlobal((g) => ({ ...g, filters: { ...g.filters, [key]: values } }));
        setConfigs(
            (c) =>
                Object.fromEntries(
                    Object.entries(c).map(([k, v]) => [
                        k,
                        { ...v, members: [] },
                    ]),
                ) as unknown as Record<PanelId, PanelConfig>,
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
        setHistory((h) => [
            ...h.slice(-15),
            { since: global.since, until: global.until, timeSpec },
        ]);
        setTimeSpec({ start, end });
        setGlobal((g) => ({ ...g, since: start, until: end }));
    }
    function back() {
        const h = history.at(-1);
        if (!h) return;
        setTimeSpec(h.timeSpec);
        setGlobal((g) => advanceTime({ ...g, since: h.since, until: h.until }, h.timeSpec));
        setHistory((v) => v.slice(0, -1));
    }
    function memberUsage(m: Member, dimension: Dimension) {
        setDrill(null);
        if (dimension === "session" && m.harness && m.session_id) {
            setGlobal((g) => ({
                ...g,
                filters: {
                    ...g.filters,
                    harness: [m.harness!],
                    session: [m.session_id!],
                },
            }));
        } else changeFilter(dimension, [m.key]);
        setUsageView((v) => ({ ...v, group: "request", offset: 0 }));
        setPage("usage");
    }
    async function scan() {
        if (refreshLock.current || refs.current.scanStatus?.scanning || refs.current.editing) return;
        refreshLock.current = true;
        setRefreshing(true);
        setError("");
        try {
            let state = await refresh();
            while (state.scanning) {
                await new Promise((r) => setTimeout(r, 700));
                const latest = await status();
                setScanStatus(latest);
                if (latest.error) throw new Error(latest.error);
                state = latest;
            }
            const latest = await status();
            setScanStatus(latest);
            if (latest.error) throw new Error(latest.error);
            setGlobal((g) => advanceTime(g, refs.current.timeSpec));
            setRevision((v) => v + 1);
        } catch (e) {
            setError(`刷新失败：${(e as Error).message}`);
        } finally {
            refreshLock.current = false;
            setRefreshing(false);
        }
    }
    const scanRef = useRef(scan);
    scanRef.current = scan;
    useEffect(() => {
        if (!autoSeconds || !liveRange) return;
        const timer = setInterval(() => {
            const r = refs.current;
            if (
                !document.hidden &&
                r.timeSpec.end === "now" &&
                !r.editing &&
                !r.busy &&
                !refreshLock.current &&
                !r.scanStatus?.scanning
            )
                void scanRef.current();
        }, autoSeconds * 1000);
        return () => clearInterval(timer);
    }, [autoSeconds, liveRange]);
    useEffect(() => {
        if (demo) return;
        let active = true;
        (async () => {
            try {
                let s = await status();
                if (active) setScanStatus(s);
                const scanning = s.scanning;
                while (active && s.scanning) {
                    await new Promise((r) => setTimeout(r, 1000));
                    s = await status();
                    if (active) setScanStatus(s);
                }
                if (active && scanning) {
                    setGlobal((g) => advanceTime(g, refs.current.timeSpec));
                    setRevision((v) => v + 1);
                }
                if (active && s.error) setError(`刷新失败：${s.error}`);
            } catch (e) {
                if (active) setError((e as Error).message);
            }
        })();
        return () => {
            active = false;
        };
    }, []);
    const updating = page === "dashboard" ? d.globalUpdating : u.pending;
    const fetchError = page === "dashboard" ? d.errors.global : u.error;
    const scanning = refreshing || scanStatus?.scanning;
    return (
        <main className="app-shell" data-testid="workbench" data-theme={theme}>
            <header className="workbench-header">
                <h1>
                    <span className="brand-dot" />
                    Harnesscope <span className="brand-subtitle">用量镜</span>
                </h1>
                <nav className="page-nav">
                    {[
                        ["dashboard", "Dashboard"],
                        ["usage", "用量明细"],
                    ].map(([k, l]) => (
                        <button
                            key={k}
                            data-testid={`page-${k}`}
                            className={page === k ? "selected" : ""}
                            onClick={() => setPage(k as typeof page)}
                        >
                            {l}
                        </button>
                    ))}
                </nav>
                <div className="heading-actions">
                    <span className="updated">
                        {scanStatus?.updated_at
                            ? `${timeLabel(scanStatus.updated_at, global.timezone)} 更新`
                            : ""}
                    </span>
                    <div className="segmented theme-toggle">
                        {[
                            ["light", "亮色"],
                            ["dark", "暗色"],
                        ].map(([k, l]) => (
                            <button
                                key={k}
                                data-testid={`theme-${k}`}
                                className={theme === k ? "selected" : ""}
                                onClick={() => setTheme(k as typeof theme)}
                            >
                                {l}
                            </button>
                        ))}
                    </div>
                </div>
            </header>
            <section className="global-query" data-testid="global-query">
                <div className="range-row">
                    <TimeControl
                        global={global}
                        spec={timeSpec}
                        onEditing={setEditing}
                        onChange={updateTime}
                    />
                    <button
                        className="primary refresh-button"
                        data-testid="scan-data"
                        disabled={!!scanning}
                        onClick={scan}
                    >
                        <Icon name="refresh" />
                        {scanning ? "刷新中…" : "刷新"}
                    </button>
                </div>
                <div className="interval-row">
                    <span className="control-label">间隔</span>
                    <div
                        className="segmented time-slices"
                        data-testid="time-slice"
                    >
                        {slices.map((s) => {
                            const disabled =
                                !!s.seconds &&
                                buckets(global, s.seconds) > 2000;
                            return (
                                <button
                                    key={s.key}
                                    data-testid={`slice-${s.key}`}
                                    className={
                                        global.bucket === s.key
                                            ? "selected"
                                            : ""
                                    }
                                    disabled={disabled}
                                    title={
                                        disabled
                                            ? "此范围超过 2000 个时间点，请缩小范围或选择较长间隔"
                                            : s.label
                                    }
                                    onClick={() =>
                                        setGlobal((g) => ({
                                            ...g,
                                            bucket: s.key,
                                        }))
                                    }
                                >
                                    {s.label}
                                </button>
                            );
                        })}
                    </div>
                    <label className="auto-toggle">
                        <input
                            type="checkbox"
                            data-testid="auto-refresh-toggle"
                            checked={liveRange && autoSeconds > 0}
                            disabled={!liveRange}
                            title={liveRange ? undefined : "截止时间为现在时，恢复自动刷新设置"}
                            onChange={(e) =>
                                setAutoSeconds(
                                    e.target.checked ? autoPeriod : 0,
                                )
                            }
                        />
                        自动刷新
                    </label>
                    {!liveRange && (
                        <span className="auto-refresh-note" data-testid="auto-refresh-note">
                            历史范围不自动刷新
                        </span>
                    )}
                    <div className="segmented auto-period">
                        {[
                            [15, "15 秒"],
                            [30, "30 秒"],
                            [60, "1 分"],
                            [300, "5 分"],
                        ].map(([n, l]) => (
                            <button
                                key={n}
                                data-testid={`auto-period-${n}`}
                                className={autoPeriod === n ? "selected" : ""}
                                disabled={!liveRange}
                                onClick={() => {
                                    setAutoPeriod(Number(n));
                                    if (autoSeconds) setAutoSeconds(Number(n));
                                }}
                            >
                                {l}
                            </button>
                        ))}
                    </div>
                    {history.length > 0 && (
                        <button
                            className="zoom-back"
                            data-testid="zoom-back"
                            onClick={back}
                        >
                            ← 返回原时间范围
                        </button>
                    )}
                </div>
                <div className="filter-line">
                    <span className="control-label">筛选</span>
                    {filters.map((k) => (
                        <Facet
                            key={k}
                            name={k}
                            options={facets?.[k] ?? []}
                            selected={global.filters[k] ?? []}
                            onChange={(v) => changeFilter(k, v)}
                        />
                    ))}
                    <button
                        data-testid="more-filters"
                        className="text-button"
                        onClick={() => setMore(!more)}
                    >
                        更多条件 {more ? "⌃" : "⌄"}
                    </button>
                    {more &&
                        extra.map((k) => (
                            <Facet
                                key={k}
                                name={k}
                                options={facets?.[k] ?? []}
                                selected={global.filters[k] ?? []}
                                onChange={(v) => changeFilter(k, v)}
                            />
                        ))}
                    {Object.values(global.filters).some((v) => v?.length) && (
                        <button
                            className="text-button"
                            data-testid="clear-filters"
                            onClick={() =>
                                setGlobal((g) => ({ ...g, filters: {} }))
                            }
                        >
                            清除筛选
                        </button>
                    )}
                </div>
                <div className="resolved-range" data-testid="resolved-range">
                    {dateInput(global.since, global.timezone).replace("T", " ")}{" "}
                    —{" "}
                    {dateInput(global.until, global.timezone).replace("T", " ")}
                    <span>本机时区 · {global.timezone}</span>
                    {editing && <span>编辑期间暂停自动刷新</span>}
                </div>
            </section>
            {(error || fetchError) && (
                <div className="error-banner">
                    {error || fetchError}
                    <button
                        onClick={() => {
                            setError("");
                            if (page === "dashboard") d.retry();
                            else u.retry();
                            void scan();
                        }}
                    >
                        刷新
                    </button>
                </div>
            )}
            {scanning && (
                <div className="notice" data-testid="scan-progress">
                    正在读取本机日志 {scanStatus?.progress.files_done ?? 0} /{" "}
                    {scanStatus?.progress.files_total ?? "…"}
                    ，本期用量尚在更新。
                </div>
            )}
            {updating && (
                <div className="updating-banner" data-testid="query-updating">
                    {(page === "dashboard" ? current : u.data)
                        ? "正在查询当前范围，下方暂时保留上次查询结果…"
                        : "正在加载当前范围…"}
                </div>
            )}
            {page === "dashboard" && current && counts && (
                <div
                    className={`data-region ${d.globalUpdating ? "is-updating" : ""}`}
                    inert={d.globalUpdating || !!d.errors.global}
                >
                    <MetricStrip
                        data={counts}
                        turnCount={current.turns.summary.turns}
                    />
                    <div className="primary-analysis">
                        <PartState
                            pending={d.pending.includes("consumption")}
                            error={d.errors.consumption}
                            onRetry={() => d.retry("consumption")}
                        >
                            <AnalyticPanel
                                id="consumption"
                                data={counts}
                                config={configs.consumption}
                                global={current.global}
                                onConfig={(c) =>
                                    setConfigs((v) => ({
                                        ...v,
                                        consumption: c,
                                    }))
                                }
                                onZoom={zoom}
                            />
                        </PartState>
                        <PartState
                            pending={d.pending.includes("consumption")}
                            error={d.errors.consumption}
                            onRetry={() => d.retry("consumption")}
                        >
                            <AbsoluteRanking
                                data={counts}
                                config={configs.consumption}
                                onConfig={(c) =>
                                    setConfigs((v) => ({
                                        ...v,
                                        consumption: c,
                                    }))
                                }
                                onSelect={(m) =>
                                    memberUsage(m, counts.query.dimension)
                                }
                            />
                        </PartState>
                    </div>
                    <details className="change-details">
                        <summary>较上一等长时段的变化</summary>
                        <Comparison
                            data={counts}
                            metric={counts.query.metric}
                            onDetail={(m) =>
                                memberUsage(m, counts.query.dimension)
                            }
                        />
                    </details>
                    <div className="supporting-analysis">
                        {(["rate", "cache", "speed"] as PanelId[]).map((id) => (
                            <PartState
                                key={id}
                                pending={d.pending.includes(id)}
                                error={d.errors[id]}
                                onRetry={() => d.retry(id)}
                            >
                                <AnalyticPanel
                                    id={id}
                                    data={current.panels[id]}
                                    config={configs[id]}
                                    global={current.global}
                                    onConfig={(c) =>
                                        setConfigs((v) => ({ ...v, [id]: c }))
                                    }
                                    onZoom={zoom}
                                />
                            </PartState>
                        ))}
                    </div>
                    <PartState
                        pending={d.pending.includes("turns")}
                        error={d.errors.turns}
                        onRetry={() => d.retry("turns")}
                    >
                        <TurnWorkbench
                            data={current.turns}
                            global={current.global}
                            onZoom={zoom}
                            view={turnView}
                            onView={setTurnView}
                        />
                    </PartState>
                    <details className="aggregate-details">
                        <summary>
                            {dimensions[counts.query.dimension]}用量汇总
                        </summary>
                        <Ledger
                            data={counts}
                            q={counts.query}
                            onDetail={(m) =>
                                memberUsage(m, counts.query.dimension)
                            }
                            onFilter={(m) =>
                                changeFilter(counts.query.dimension, [m.key])
                            }
                        />
                    </details>
                </div>
            )}
            {page === "usage" && u.data && (
                <div
                    className={`data-region ${u.pending ? "is-updating" : ""}`}
                    inert={u.pending || !!u.error}
                >
                    <UsageTable
                        data={u.data}
                        view={usageView}
                        onView={setUsageView}
                        drill={drill}
                        onDrill={(row) => {
                            if (!drill) setDrillBack(usageView);
                            const identity = Object.fromEntries(
                                Object.entries(row.identity).filter(
                                    ([key, value]) =>
                                        value != null ||
                                        (key === "turn_id" && row.group === "turn"),
                                ),
                            );
                            setDrill({
                                identity: { ...drill?.identity, ...identity },
                                label: drill ? `${drill.label} → ${row.label}` : row.label,
                                group: drill?.group ?? row.group,
                            });
                            setUsageView((v) => ({
                                ...v,
                                group: "request",
                                offset: 0,
                            }));
                        }}
                        onBack={() => {
                            setDrill(null);
                            setUsageView(drillBack);
                        }}
                    />
                </div>
            )}
            <details className="source-health" data-testid="source-health">
                <summary>
                    数据来源{" "}
                    <span>{scanStatus?.sources.length ?? 0} 个本机来源</span>
                </summary>
                <div className="sources-grid">
                    {scanStatus?.sources.map((s) => (
                        <article key={s.harness}>
                            <header>
                                <b>{harnessLabel(s.harness)}</b>
                                <span className={`source-state ${s.state}`}>
                                    {
                                        {
                                            ready: "已读取",
                                            partial: "部分数据",
                                            missing: "未发现",
                                            error: "读取失败",
                                            scanning: "读取中",
                                        }[s.state]
                                    }
                                </span>
                            </header>
                            <p>
                                {s.files} 个文件 · {s.events} 条可用记录
                            </p>
                            {s.warnings.map((w, i) => (
                                <small key={i}>{w}</small>
                            ))}
                        </article>
                    ))}
                </div>
            </details>
        </main>
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
