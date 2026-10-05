import { useEffect, useState } from "react";
import type { GlobalQuery } from "./types";
import { resolveTime, type TimeSpec } from "./time";
import { dateInput, inputDate } from "./format";
const isAbsolute = (spec: TimeSpec) =>
    spec.end !== "now" &&
    !spec.start.startsWith("-") &&
    !spec.end.startsWith("-");
export function TimeControl({
    global,
    spec,
    onChange,
    onEditing,
}: {
    global: GlobalQuery;
    spec: TimeSpec;
    onChange: (spec: TimeSpec, range: { since: string; until: string }) => void;
    onEditing: (v: boolean) => void;
}) {
    const display = (v: string) =>
        v === "now"
            ? "现在"
            : v.startsWith("-")
              ? v
              : dateInput(v, global.timezone).replace("T", " ");
    const [start, setStart] = useState(display(spec.start)),
        [end, setEnd] = useState(display(spec.end)),
        [absolute, setAbsolute] = useState(isAbsolute(spec)),
        [error, setError] = useState("");
    useEffect(() => {
        setStart(display(spec.start));
        setEnd(display(spec.end));
        setAbsolute(isAbsolute(spec));
        setError("");
        onEditing(false);
    }, [spec.start, spec.end, global.timezone]);
    const normalize = (v: string) => {
        v = v.trim();
        if (/^(now|现在)$/i.test(v)) return "now";
        if (v.startsWith("-")) return v;
        if (/(Z|[+-]\d\d:\d\d)$/.test(v)) return new Date(v).toISOString();
        return inputDate(v.replace(" ", "T"), global.timezone);
    };
    function changeMode(next: boolean) {
        if (next === absolute) return;
        setAbsolute(next);
        setStart(
            next
                ? dateInput(global.since, global.timezone)
                : isAbsolute(spec)
                  ? "-1h"
                  : display(spec.start),
        );
        setEnd(
            next
                ? dateInput(global.until, global.timezone)
                : isAbsolute(spec)
                  ? "现在"
                  : display(spec.end),
        );
        setError("");
        onEditing(true);
    }
    function apply() {
        try {
            const next = { start: normalize(start), end: normalize(end) };
            onChange(next, resolveTime(next));
            setAbsolute(isAbsolute(next));
            setStart(display(next.start));
            setEnd(display(next.end));
            onEditing(false);
            setError("");
        } catch (e) {
            setError((e as Error).message);
        }
    }
    return (
        <div className="inline-time">
            <div className="segmented time-mode" role="group" aria-label="时间类型">
                {([
                    [false, "相对时间"],
                    [true, "绝对时间"],
                ] as const).map(([value, label]) => (
                    <button
                        key={String(value)}
                        data-testid={`time-mode-${value ? "absolute" : "relative"}`}
                        className={absolute === value ? "selected" : ""}
                        aria-pressed={absolute === value}
                        onClick={() => changeMode(Boolean(value))}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <label>
                从
                <input
                    data-testid="time-start"
                    aria-label="开始时间"
                    type={absolute ? "datetime-local" : "text"}
                    step={absolute ? 1 : undefined}
                    value={absolute ? start.replace(" ", "T") : start}
                    placeholder="-18h 或 2026-10-01 00:00:00"
                    onFocus={() => onEditing(true)}
                    onChange={(e) => setStart(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") apply();
                    }}
                />
            </label>
            <span className="time-arrow">→</span>
            <label>
                到
                <input
                    data-testid="time-end"
                    aria-label="结束时间"
                    type={absolute ? "datetime-local" : "text"}
                    step={absolute ? 1 : undefined}
                    value={absolute ? end.replace(" ", "T") : end}
                    placeholder="现在"
                    onFocus={() => onEditing(true)}
                    onChange={(e) => setEnd(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") apply();
                    }}
                />
            </label>
            <button data-testid="time-apply" onClick={apply}>
                应用
            </button>
            <div className="time-presets">
                {[
                    ["15m", "15 分"],
                    ["1h", "1 小时"],
                    ["6h", "6 小时"],
                    ["24h", "24 小时"],
                    ["7d", "7 天"],
                ].map(([k, l]) => (
                    <button
                        key={k}
                        onClick={() => {
                            const next = { start: `-${k}`, end: "now" };
                            onChange(next, resolveTime(next));
                            setAbsolute(false);
                            setStart(next.start);
                            setEnd("现在");
                            setError("");
                            onEditing(false);
                        }}
                    >
                        {l}
                    </button>
                ))}
            </div>
            {error && (
                <span className="error-text time-error" role="alert">
                    {error}
                </span>
            )}
        </div>
    );
}
