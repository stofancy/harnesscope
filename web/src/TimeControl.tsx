import { useEffect, useState } from "react";
import type { GlobalQuery } from "./types";
import { resolveTime, type TimeSpec } from "./time";
import { dateInput, inputDate } from "./format";
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
        [error, setError] = useState("");
    useEffect(() => {
        setStart(display(spec.start));
        setEnd(display(spec.end));
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
    function apply() {
        try {
            const next = { start: normalize(start), end: normalize(end) };
            onChange(next, resolveTime(next));
            onEditing(false);
            setError("");
        } catch (e) {
            setError((e as Error).message);
        }
    }
    return (
        <div className="inline-time">
            <label>
                从
                <input
                    data-testid="time-start"
                    aria-label="开始时间"
                    value={start}
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
                    value={end}
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
                            onEditing(false);
                        }}
                    >
                        {l}
                    </button>
                ))}
            </div>
            {error && <span className="error-text time-error">{error}</span>}
        </div>
    );
}
