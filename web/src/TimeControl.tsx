import { useEffect, useRef, useState } from "react";
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
    function pickerValue(value: string, fallback: string) {
        try {
            const normalized = normalize(value);
            const iso = normalized === "now"
                ? new Date().toISOString()
                : normalized.startsWith("-")
                  ? resolveTime({ start: normalized, end: "now" }).since
                  : normalized;
            return dateInput(iso, global.timezone);
        } catch {
            return dateInput(fallback, global.timezone);
        }
    }
    function apply() {
        try {
            const next = { start: normalize(start), end: normalize(end) };
            onChange(next, resolveTime(next));
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
            <TimeField
                id="start" label="从" name="开始" value={start}
                timezone={global.timezone}
                calendarValue={pickerValue(start, global.since)}
                onChange={setStart} onEditing={onEditing} onApply={apply}
            />
            <span className="time-arrow">→</span>
            <TimeField
                id="end" label="到" name="结束" value={end}
                timezone={global.timezone}
                calendarValue={pickerValue(end, global.until)}
                onChange={setEnd} onEditing={onEditing} onApply={apply}
            />
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

function TimeField({
    id, label, name, value, calendarValue, timezone, onChange, onEditing, onApply,
}: {
    id: string; label: string; name: string; value: string; calendarValue: string;
    timezone: string;
    onChange: (value: string) => void;
    onEditing: (value: boolean) => void;
    onApply: () => void;
}) {
    const calendar = useRef<HTMLInputElement>(null);
    return (
        <div className="time-field">
            <label htmlFor={`time-${id}`}>{label}</label>
            <div className="time-input">
                <input
                    id={`time-${id}`} data-testid={`time-${id}`} type="text"
                    aria-label={`${name}时间`} value={value}
                    placeholder="-1h、现在或具体时间"
                    onFocus={() => onEditing(true)}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") onApply(); }}
                />
                <input
                    ref={calendar} className="time-calendar-input"
                    data-testid={`time-${id}-calendar`} type="datetime-local"
                    step="1" value={calendarValue} aria-hidden="true" tabIndex={-1}
                    max={dateInput(new Date().toISOString(), timezone)}
                    onChange={(e) => {
                        if (e.target.value) {
                            onChange(e.target.value.replace("T", " "));
                            onEditing(true);
                        }
                    }}
                />
                <button
                    className="calendar-button" data-testid={`time-${id}-picker`}
                    aria-label={`选择${name}日期时间`} title={`选择${name}日期时间`}
                    onClick={() => {
                        onEditing(true);
                        if (calendar.current) {
                            calendar.current.max = dateInput(new Date().toISOString(), timezone);
                            calendar.current.showPicker();
                        }
                    }}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                        <rect x="3" y="5" width="18" height="16" rx="2" />
                        <path d="M16 3v4M8 3v4M3 11h18" />
                    </svg>
                </button>
            </div>
        </div>
    );
}
