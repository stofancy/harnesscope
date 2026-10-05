import type { Metric } from "./types.ts";
export const metricLabels: Record<Metric, string> = {
    input: "输入 Tokens",
    output: "输出 Tokens",
    cache_read: "缓存读取 Tokens",
    cache_write: "缓存写入 Tokens",
    tpm: "每分钟 Tokens (TPM)",
    rpm: "每分钟调用 (RPM)",
    throughput_tps: "每秒平均 Tokens",
    rps: "每秒调用 (RPS)",
    timed_tps: "执行输出速度 (TPS)",
    cost: "估算费用",
    tokens: "Tokens",
    calls: "已记录调用",
    cost_per_call: "每调用费用",
    cost_per_million: "每百万 Token 费用",
    cache_rate: "缓存命中率",
};
export const formatNumber = (n: number) =>
    new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 1,
        notation: "compact",
    }).format(n);
export const exactNumber = (n: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);
export const formatMetric = (n: number | null | undefined, m: Metric) =>
    n == null
        ? "—"
        : m === "cache_rate"
          ? `${(n * 100).toFixed(1)}%`
          : m.includes("cost")
            ? `$${n.toFixed(n > 0 && n < 0.01 ? 6 : n > 0 && n < 1 ? 4 : m === "cost_per_call" ? 4 : 2)}`
            : ["rpm", "rps", "throughput_tps", "timed_tps"].includes(m)
              ? new Intl.NumberFormat("en-US", {
                    maximumFractionDigits: 2,
                }).format(n)
              : formatNumber(n);
export function dateInput(iso: string, timezone: string) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(new Date(iso));
    const p = Object.fromEntries(parts.map((v) => [v.type, v.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
export function inputDate(local: string, timezone: string) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(local))
        throw new Error("请输入完整日期和时间");
    const desired = new Date(`${local}Z`).getTime();
    if (!Number.isFinite(desired)) throw new Error("时间无效");
    let candidate = desired;
    for (let i = 0; i < 3; i++) {
        const rendered = new Date(
            `${dateInput(new Date(candidate).toISOString(), timezone)}Z`,
        ).getTime();
        candidate += desired - rendered;
    }
    const result = new Date(candidate).toISOString();
    if (
        dateInput(result, timezone) !==
        (local.length === 16 ? `${local}:00` : local)
    )
        throw new Error("该时区不存在此时间，请选择其他时间");
    return result;
}
export function timeLabel(iso: string, timezone: string, full = false) {
    return new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        month: "2-digit",
        day: "2-digit",
        ...(full
            ? { year: "numeric", hour: "2-digit", minute: "2-digit" }
            : { hour: "2-digit", minute: "2-digit" }),
        hourCycle: "h23",
    }).format(new Date(iso));
}
export function deltaPercent(now: number | null, before: number | null) {
    if (now == null || before == null) return null;
    if (before === 0) return now === 0 ? "0.0%" : "新增";
    const delta = ((now - before) / before) * 100;
    return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

export const intervalLabel = (bucket: string) =>
    ({
        auto: "自动",
        second: "每秒",
        "5second": "每5秒",
        "10second": "每10秒",
        "30second": "每30秒",
        minute: "每分钟",
        "5minute": "每5分钟",
        "15minute": "每15分钟",
        hour: "每小时",
        day: "每天",
        week: "每周",
        month: "每月",
    })[bucket] ?? bucket;
export const timingLabel = (kind: string) =>
    ({ end_to_end: "轮次全程", model: "模型响应" })[kind] ?? "其他计时";
export const harnessLabel = (harness: string) =>
    ({ codex: "Codex", claude: "Claude Code", omp: "OMP", dsh: "DSH" })[
        harness
    ] ?? harness;
export const boundaryLabel = (quality: string) =>
    ({ exact: "明确边界", inferred: "推定边界", unknown: "边界未知" })[
        quality
    ] ?? "边界未知";
