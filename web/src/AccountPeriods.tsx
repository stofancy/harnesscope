import { useEffect, useRef, useState } from "react";
import { accountDirectory } from "./api";
import { accountKind, accountName } from "./names";
import { dateInput, harnessLabel } from "./format";
import type { Account, AccountDirectory, AccountPeriod } from "./types";
import "./accounts.css";

const numeric = (value: number | null | undefined) => value == null
    ? "未记录" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
const scopeLabel = (scope: AccountPeriod["scope"]) => {
    const parts = [scope.model ? `模型 ${scope.model}` : "",
        scope.shared === true ? "共享额度" : scope.shared === false ? "非共享额度" : "",
        scope.org ? `组织 ${scope.org}` : "", scope.project ? `项目 ${scope.project}` : "",
        scope.tier ? `模式 ${scope.tier}` : "", scope.window_id ? `窗口 ${scope.window_id}` : ""].filter(Boolean);
    return parts.join(" · ") || "范围未记录";
};
const unitLabel = (unit: string | null) => ({ percent: "%", tokens: "Tokens", requests: "次请求", usd: "USD", minutes: "分钟", bytes: "字节", unknown: "单位未记录" } as Record<string, string>)[unit ?? ""] ?? unit ?? "单位未记录";
const amount = (value: number | null, unit: string | null) => value == null ? "未记录" : `${numeric(value)} ${unitLabel(unit)}`;
const boundaryLabel = (quality: string) => ({ reported: "原生报告", inferred: "按重置点与窗口长度推导", unknown: "边界未记录" } as Record<string, string>)[quality] ?? "边界未记录";
const timestamp = (value: string | null, timezone: string) => value
    ? dateInput(value, timezone).replace("T", " ") : "未记录";
function unusable(period: AccountPeriod) {
    if (!period.start || !period.end) return "缺少周期起止，无法应用时间范围";
    const start = Date.parse(period.start), end = Date.parse(period.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
        return "周期起止不可用";
    if (start >= Date.now()) return "周期尚未开始";
    return null;
}

export function AccountPeriods({ snapshot, revision, timezone, onApply }: {
    snapshot: string | null; revision: number; timezone: string;
    onApply: (account: Account, period?: AccountPeriod) => void;
}) {
    const [data, setData] = useState<AccountDirectory | null>(null);
    const [pending, setPending] = useState(false), [error, setError] = useState("");
    const [retry, setRetry] = useState(0), [open, setOpen] = useState(false);
    const [accountRef, setAccountRef] = useState("");
    const [periodId, setPeriodId] = useState("");
    const loaded = useRef<{ revision: number; retry: number; snapshot: string } | null>(null);
    useEffect(() => {
        if (loaded.current?.revision === revision && loaded.current.retry === retry &&
            (!snapshot || loaded.current.snapshot === snapshot)) return;
        const controller = new AbortController();
        setPending(true);
        setError("");
        accountDirectory(controller.signal).then(result => {
            if (controller.signal.aborted) return;
            loaded.current = { revision, retry, snapshot: String(result.snapshot.id) };
            setData(result);
            setPending(false);
        }).catch(e => {
            if (!controller.signal.aborted) { setError(e.message); setPending(false); }
        });
        return () => controller.abort();
    }, [snapshot, revision, retry]);
    const sourceErrors = data?.coverage.sources?.filter(source => source.status === "error") ?? [];
    const account = data?.accounts.find(a => a.account_ref === accountRef) ?? data?.accounts[0];
    const periods = (data?.periods ?? []).filter(p => p.account_ref === account?.account_ref)
        .sort((a, b) => Date.parse(b.observed_at ?? "") - Date.parse(a.observed_at ?? ""));
    const period = periods.find(p => p.id === periodId) ?? periods[0];
    const reason = period ? unusable(period) : null;
    const expired = !!period?.expires_at && Date.parse(period.expires_at) <= Date.now();
    const ended = !!period?.end && Date.parse(period.end) <= Date.now();
    return <details className="account-periods panel" data-testid="account-periods" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
        <summary data-testid="account-periods-toggle">
            <strong>账号与用量周期</strong>
            <span>离线额度快照{data ? ` · ${data.accounts.length} 个已知账号` : ""}</span>
            <span className="account-directory-state">{pending ? "正在读取…" : error ? "目录读取失败" : ""}</span>
        </summary>
        <div className="account-periods-content">
            {error && <p className="account-directory-error" data-testid="account-directory-error">{error}
                <button onClick={() => setRetry(n => n + 1)}>重载目录</button></p>}
            {!data && pending && <p className="muted">正在读取本机已索引账号与额度记录…</p>}
            {sourceErrors.map(source => <p className="account-directory-error" data-testid="account-source-error" key={source.harness}>
                {harnessLabel(source.harness)} 账号元数据读取失败{source.error ? ` · ${source.error}` : ""}
                {source.retained ? "；保留上次可信目录" : "；账号目录暂不可用"}，修复来源后刷新。
            </p>)}
            {data && !data.accounts.length && <p className="muted" data-testid="accounts-empty">{sourceErrors.length ? "当前账号目录暂不可用。" : "当前本机日志没有已知账号。"}已记录调用仍可在下方查看。</p>}
            {account && <>
                <div className="account-directory-controls">
                    <label><span>已知账号</span><select data-testid="account-select" value={account.account_ref}
                        disabled={pending} onChange={e => { setAccountRef(e.target.value); setPeriodId(""); }}>
                        {data!.accounts.map(a => <option key={a.account_ref} value={a.account_ref}>
                            {accountName(a)} · {harnessLabel(a.harness)} / {a.provider || "Provider 未记录"}
                        </option>)}
                    </select></label>
                    <label><span>已观测窗口</span><select data-testid="account-period-select" disabled={pending || !periods.length}
                        value={period?.id ?? ""} onChange={e => setPeriodId(e.target.value)}>
                        {!periods.length && <option value="">没有已记录周期</option>}
                        {periods.map(p => <option value={p.id} key={p.id}>{p.label || p.limit_id || "用量周期"} · {timestamp(p.observed_at, timezone)}</option>)}
                    </select></label>
                </div>
                <div className="account-period-body">
                    <div className="account-native-info" data-testid="account-info">
                        <strong>{account.label || "已知账号"}</strong><span>{accountKind(account.kind)} · {harnessLabel(account.harness)} · {account.provider || "Provider 未记录"}</span>
                        {period ? <>
                            <dl className="account-period-dates" data-testid="account-period-boundaries">
                                <div><dt>周期起止</dt><dd>{timestamp(period.start, timezone)} — {timestamp(period.end, timezone)}</dd></div>
                                <div><dt>边界来源</dt><dd>{boundaryLabel(period.boundary_quality)}{period.duration_ms != null ? ` · ${(period.duration_ms / 3600000).toLocaleString()} 小时窗口` : ""}</dd></div>
                                <div><dt>最后观测</dt><dd>{timestamp(period.observed_at, timezone)}</dd></div>
                                <div><dt>快照失效</dt><dd>{timestamp(period.expires_at, timezone)}{expired ? " · 已失效，保留最后观测" : ""}</dd></div>
                            </dl>
                            {ended && <span className="account-period-ended">周期已结束</span>}
                            {reason && <p className="account-period-reason" data-testid="account-period-reason">{reason}</p>}
                        </> : <p className="account-period-reason" data-testid="account-period-reason">没有可用周期；可在当前时间范围查看该账号的已记录用量。</p>}
                    </div>
                    {period && <div className="account-quota" data-testid="account-quota">
                        <div className="account-quota-heading"><span>原生额度 · {scopeLabel(period.scope)}</span>
                            <strong data-testid="account-quota-fraction">{period.used_fraction == null ? "比例未记录" : `${numeric(period.used_fraction * 100)}%`}</strong></div>
                        {period.used_fraction != null && <div className="account-quota-bar"><i style={{ width: `${Math.max(0, Math.min(100, period.used_fraction * 100))}%` }} /></div>}
                        <dl><div><dt>已用</dt><dd>{amount(period.used, period.unit)}</dd></div>
                            <div><dt>限额</dt><dd>{amount(period.limit, period.unit)}</dd></div>
                            <div><dt>剩余</dt><dd>{amount(period.remaining, period.unit)}</dd></div></dl>
                        <p>保留原生额度范围；模型筛选仅改变本机已记录用量。</p>
                    </div>}
                </div>
                <footer className="account-period-actions">
                    {period && <button className="primary" data-testid="apply-account-period" disabled={pending || !!error || !!reason}
                        onClick={() => onApply(account, period)}>查看周期用量</button>}
                    <button data-testid="apply-account" disabled={pending || !!error} onClick={() => onApply(account)}>查看账号用量</button>
                    <span>{period && !reason ? "周期用量截至查看时刻，最晚到周期结束；再次点击更新截至时间。" : "使用当前全局时间范围。"}</span>
                </footer>
            </>}
        </div>
    </details>;
}
