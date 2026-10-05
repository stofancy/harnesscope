import { useEffect, useState } from "react";
import { usage } from "./api";
import type {
    GlobalQuery,
    UsageAnalysis,
    UsageDrill,
    UsageView,
    UsageRow,
    UsageGroup,
} from "./types";
import {
    exactNumber,
    formatMetric,
    harnessLabel,
    timeLabel,
    timingLabel,
} from "./format";
export function useUsage(
    global: GlobalQuery,
    view: UsageView,
    drill: UsageDrill | null,
    revision: number,
    enabled: boolean,
) {
    const [data, setData] = useState<UsageAnalysis | null>(null),
        [pending, setPending] = useState(false),
        [error, setError] = useState(""),
        [retry, setRetry] = useState(0),
        [loadedKey, setLoadedKey] = useState("");
    const key = JSON.stringify({ global, view, drill });
    useEffect(() => {
        if (!enabled) {
            setPending(false);
            return;
        }
        const c = new AbortController();
        setPending(true);
        setError("");
        usage(global, view, drill, c.signal)
            .then((r) => {
                if (!c.signal.aborted) {
                    setData(r);
                    setLoadedKey(key);
                    setPending(false);
                }
            })
            .catch((e) => {
                if (!c.signal.aborted) {
                    setError(e.message);
                    setPending(false);
                }
            });
        return () => c.abort();
    }, [key, revision, enabled, retry]);
    return {
        data,
        pending: pending || (!error && loadedKey !== key),
        error,
        retry: () => setRetry((v) => v + 1),
    };
}
const groupLabels: Record<UsageGroup, string> = {
    request: "逐次请求",
    session: "会话",
    turn: "轮次",
    model: "模型",
    harness: "Harness",
};
const columns = [
    ["time", "最近请求"],
    ["calls", "请求"],
    ["input_net", "输入（未缓存）"],
    ["cache_read", "缓存命中"],
    ["output", "输出"],
    ["cache_write", "缓存写入"],
    ["response_tps", "响应 TPS"],
    ["turn_tps", "轮次 TPS"],
    ["cost_usd", "估算费用"],
] as const;
const shortId = (v: string) =>
    v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v;
const tpsNumber = (v: number | null | undefined) =>
    v == null
        ? "—"
        : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
              v,
          );
const projectName = (v: string) =>
    v.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || v;
const number = (v: number | null | undefined) =>
    v == null ? "—" : exactNumber(v);
export function UsageTable({
    data,
    view,
    onView,
    drill,
    onDrill,
    onBack,
}: {
    data: UsageAnalysis;
    view: UsageView;
    onView: (v: UsageView) => void;
    drill: UsageDrill | null;
    onDrill: (d: UsageDrill) => void;
    onBack: () => void;
}) {
    const [expanded, setExpanded] = useState<string | null>(null);
    useEffect(
        () => setExpanded(null),
        [data.snapshot_id, JSON.stringify(view), JSON.stringify(data.query)],
    );
    function name(r: UsageRow) {
        if (view.group === "model") return r.identity.model || "未记录模型";
        if (view.group === "harness")
            return harnessLabel(r.identity.harness || "");
        return r.projects.map(projectName).join(" / ") || "未记录项目";
    }
    const sort = (key: string) =>
        onView({
            ...view,
            sort: key,
            order: view.sort === key && view.order === "desc" ? "asc" : "desc",
            offset: 0,
        });
    return (
        <section className="usage-panel panel" data-testid="usage-table">
            <header className="usage-heading">
                <div className="segmented usage-groups">
                    {Object.entries(groupLabels).map(([key, l]) => (
                        <button
                            data-testid={`usage-group-${key}`}
                            className={view.group === key ? "selected" : ""}
                            key={key}
                            onClick={() =>
                                onView({
                                    ...view,
                                    group: key as UsageGroup,
                                    offset: 0,
                                })
                            }
                        >
                            {l}
                        </button>
                    ))}
                </div>
                <span className="muted">
                    {data.total} {view.group === "request" ? "次请求" : "项"} ·
                    全结果排序
                </span>
            </header>
            {drill && (
                <div
                    className="drill-context"
                    data-testid="usage-drill-context"
                >
                    <button data-testid="usage-drill-back" onClick={onBack}>
                        ← 返回{groupLabels[drill.group]}汇总
                    </button>
                    <span>{drill.label}</span>
                </div>
            )}
            <div className="usage-totals">
                <span>
                    已记录 Tokens{" "}
                    <b data-testid="usage-total-tokens">
                        {number(data.summary.tokens)}
                    </b>
                </span>
                <span>
                    估算费用{" "}
                    <b data-testid="usage-total-cost">
                        {formatMetric(data.summary.cost, "cost")}
                        {data.summary.unpriced > 0 ? " · 部分" : ""}
                    </b>
                </span>
                <span>
                    模型调用 <b>{number(data.summary.calls)}</b>
                </span>
            </div>
            <div className="table-scroll">
                <table>
                    <thead>
                        <tr>
                            <th>
                                <button
                                    data-testid="usage-sort-time"
                                    onClick={() => sort("time")}
                                >
                                    最近请求
                                    {view.sort === "time"
                                        ? view.order === "desc"
                                            ? " ↓"
                                            : " ↑"
                                        : ""}
                                </button>
                            </th>
                            <th className="identity-col">
                                {groupLabels[view.group]}
                            </th>
                            <th>Harness / 模型</th>
                            {columns.slice(1).map(([k, l]) => (
                                <th key={k}>
                                    <button
                                        data-testid={`usage-sort-${k}`}
                                        onClick={() => sort(k)}
                                    >
                                        {l}
                                        {view.sort === k
                                            ? view.order === "desc"
                                                ? " ↓"
                                                : " ↑"
                                            : ""}
                                    </button>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {data.rows.map((r) => (
                            <Rows
                                key={r.key}
                                r={r}
                                name={name(r)}
                                view={view}
                                timezone={data.query.timezone}
                                expanded={expanded === r.key}
                                onClick={() => {
                                    if (view.group === "request")
                                        setExpanded(
                                            expanded === r.key ? null : r.key,
                                        );
                                    else
                                        onDrill({
                                            identity: r.identity,
                                            label: `${name(r)}${r.identity.session_id ? ` · ${shortId(r.identity.session_id)}` : ""}`,
                                            group: view.group,
                                        });
                                }}
                            />
                        ))}
                    </tbody>
                </table>
                {!data.rows.length && (
                    <p className="empty">此范围没有已记录请求</p>
                )}
            </div>
            <footer className="table-bottom">
                <span>
                    每页 {view.limit} 项 · 第{" "}
                    {Math.floor(view.offset / view.limit) + 1} /{" "}
                    {Math.max(1, Math.ceil(data.total / view.limit))} 页
                </span>
                <div>
                    <button
                        data-testid="usage-prev"
                        disabled={view.offset === 0}
                        onClick={() =>
                            onView({
                                ...view,
                                offset: Math.max(0, view.offset - view.limit),
                            })
                        }
                    >
                        上一页
                    </button>
                    <button
                        data-testid="usage-next"
                        disabled={view.offset + view.limit >= data.total}
                        onClick={() =>
                            onView({
                                ...view,
                                offset: view.offset + view.limit,
                            })
                        }
                    >
                        下一页
                    </button>
                </div>
            </footer>
        </section>
    );
}
function Rows({
    r,
    name,
    view,
    timezone,
    expanded,
    onClick,
}: {
    r: UsageRow;
    name: string;
    view: UsageView;
    timezone: string;
    expanded: boolean;
    onClick: () => void;
}) {
    return (
        <>
            <tr data-testid="usage-row">
                <td className="usage-time">
                    {timeLabel(r.last, timezone, true)}
                </td>
                <td className="identity-col">
                    <button
                        className="row-name"
                        data-testid="usage-row-open"
                        title={`${r.projects.join(" / ")}\n${JSON.stringify(r.identity)}`}
                        onClick={onClick}
                    >
                        <span className="usage-project-name">{name}</span>
                        {r.identity.session_id && (
                            <span
                                className="usage-visible-id"
                                data-testid="usage-session-id"
                            >
                                {shortId(r.identity.session_id)}
                            </span>
                        )}
                    </button>
                    {view.group === "turn" && (
                        <small
                            className="usage-visible-id"
                            data-testid="usage-turn-id"
                        >
                            {r.identity.turn_id
                                ? `轮次 ${shortId(r.identity.turn_id)}`
                                : "未关联轮次"}
                        </small>
                    )}
                </td>
                <td className="usage-source">
                    <span>{r.harnesses.map(harnessLabel).join(" / ")}</span>
                    <small title={r.models.join(" / ")}>
                        {r.models.join(" / ") || "未记录模型"}
                    </small>
                </td>
                <td>{number(r.metrics.calls)}</td>
                <td>{number(r.metrics.input_net)}</td>
                <td>{number(r.metrics.cache_read)}</td>
                <td>{number(r.metrics.output)}</td>
                <td>{number(r.metrics.cache_write)}</td>
                <td data-testid="usage-response-tps">
                    {tpsNumber(r.response_tps)}
                </td>
                <td data-testid="usage-turn-tps">{tpsNumber(r.turn_tps)}</td>
                <td>
                    {formatMetric(r.metrics.cost, "cost")}
                    {r.metrics.unpriced > 0 && (
                        <small className="partial-label">部分价格</small>
                    )}
                </td>
            </tr>
            {expanded && (
                <tr
                    className="usage-request-detail"
                    data-testid="usage-request-detail"
                >
                    <td colSpan={11}>
                        <div>
                            <span>
                                项目{" "}
                                <code>
                                    {r.projects.join(" / ") || "未记录"}
                                </code>
                            </span>
                            {Object.entries(r.identity)
                                .filter(([, v]) => v != null)
                                .map(([k, v]) => (
                                    <span key={k}>
                                        {
                                            (
                                                {
                                                    harness: "Harness",
                                                    session_id: "会话",
                                                    turn_id: "轮次",
                                                    event_key: "请求",
                                                    model: "模型",
                                                } as Record<string, string>
                                            )[k]
                                        }{" "}
                                        <code>{v}</code>
                                    </span>
                                ))}
                        </div>
                        {r.timing.length ? (
                            r.timing.map((t) => (
                                <p key={`${t.harness}:${t.kind}`}>
                                    {harnessLabel(t.harness)} ·{" "}
                                    {timingLabel(t.kind)} {tpsNumber(t.tps)} TPS
                                    · {t.samples} 个样本 / {number(t.seconds)}{" "}
                                    秒
                                </p>
                            ))
                        ) : (
                            <p className="muted">无可用的请求计时</p>
                        )}
                        {r.metrics.input_complete === false && (
                            <p>输入组成有缺失，Tokens 为已记录分量小计。</p>
                        )}
                        {r.metrics.unpriced > 0 && (
                            <p>
                                {r.metrics.unpriced}{" "}
                                次调用缺价，费用为已知估算小计。
                            </p>
                        )}
                    </td>
                </tr>
            )}
        </>
    );
}
