import parseDuration from "parse-duration";
import type { GlobalQuery } from "./types";
export type TimeSpec = { start: string; end: string };
const relativePattern =
    /^-\s*(?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mo|months?|y|years?)\s*)+$/i;
export function resolveTime(spec: TimeSpec, now = new Date()) {
    const resolve = (v: string) => {
        if (v === "now") return now.getTime();
        if (!v.startsWith("-")) return Date.parse(v);
        if (!relativePattern.test(v) || v.length > 120)
            throw new Error("请输入相对时长，例如 -18h、-2days 或 -1d 6h");
        const duration = parseDuration(v);
        if (duration == null || !Number.isFinite(duration) || duration >= 0)
            throw new Error("相对时长须大于零");
        return now.getTime() + duration;
    };
    const start = resolve(spec.start),
        end = resolve(spec.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
        throw new Error("结束时间须晚于开始时间");
    return {
        since: new Date(start).toISOString(),
        until: new Date(end).toISOString(),
    };
}
export function timeMode(spec: TimeSpec) {
    return spec.end !== "now"
        ? "fixed"
        : spec.start.startsWith("-")
          ? "relative"
          : "since";
}
export function humanRelative(expr: string) {
    const units: Record<string, string> = {
        h: "小时",
        hr: "小时",
        hour: "小时",
        d: "天",
        day: "天",
        m: "分钟",
        min: "分钟",
        minute: "分钟",
        s: "秒",
        sec: "秒",
        second: "秒",
        w: "周",
        week: "周",
        mo: "月",
        month: "月",
        y: "年",
        year: "年",
        ms: "毫秒",
        millisecond: "毫秒",
    };
    return expr
        .replace(/^-\s*/, "")
        .replace(
            /[a-z]+/gi,
            (u) =>
                units[u.toLowerCase().replace(/s$/, "")] ??
                units[u.toLowerCase()] ??
                u,
        );
}
export function advanceTime(q: GlobalQuery, spec: TimeSpec) {
    return spec.end === "now" ||
        spec.start.startsWith("-") ||
        spec.end.startsWith("-")
        ? { ...q, ...resolveTime(spec) }
        : q;
}
