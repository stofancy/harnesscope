import { useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { zhCN } from "react-day-picker/locale";
import type { GlobalQuery } from "./types";
import type { TimeSpec } from "./time";
import { humanRelative, resolveTime, timeMode } from "./time";
import { dateInput, inputDate, timeLabel } from "./format";
import { Icon } from "./components";
const calendarDay = (local: string) => {
    const [y, m, d] = local.slice(0, 10).split("-").map(Number);
    return Number.isFinite(y + m + d) ? new Date(y, m - 1, d) : undefined;
};
const localDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function TimeControl({
    global,
    spec,
    onChange,
    onEditing,
}: {
    global: GlobalQuery;
    spec: TimeSpec;
    onChange: (spec: TimeSpec, range: { since: string; until: string }) => void;
    onEditing: (editing: boolean) => void;
}) {
    const [open, setOpen] = useState(false),
        [mode, setMode] = useState<"relative" | "since" | "fixed">("relative"),
        [expression, setExpression] = useState("-7d"),
        [start, setStart] = useState(""),
        [end, setEnd] = useState(""),
        [error, setError] = useState("");
    function close() {
        setOpen(false);
        onEditing(false);
    }
    function edit() {
        setMode(timeMode(spec));
        setExpression(spec.start.startsWith("-") ? spec.start : "-7d");
        setStart(dateInput(global.since, global.timezone));
        setEnd(dateInput(global.until, global.timezone));
        setError("");
        setOpen(true);
        onEditing(true);
    }
    function apply() {
        try {
            const next: TimeSpec =
                mode === "relative"
                    ? { start: expression.trim(), end: "now" }
                    : {
                          start: inputDate(start, global.timezone),
                          end:
                              mode === "since"
                                  ? "now"
                                  : inputDate(end, global.timezone),
                      };
            onChange(next, resolveTime(next));
            close();
        } catch (e) {
            setError((e as Error).message);
        }
    }
    function preset(days: number) {
        const next = {
            start: `-${days === 1 ? "24h" : `${days}d`}`,
            end: "now",
        };
        onChange(next, resolveTime(next));
    }
    function selectRange(range: DateRange | undefined) {
        if (range?.from)
            setStart(
                `${localDay(range.from)}T${start.slice(11) || "00:00:00"}`,
            );
        if (range?.to)
            setEnd(`${localDay(range.to)}T${end.slice(11) || "23:59:59"}`);
    }
    return (
        <div className="range time-control" data-testid="time-range">
            <div className="presets">
                {[1, 7, 30].map((d) => (
                    <button
                        key={d}
                        className={
                            spec.end === "now" &&
                            [
                                d === 1 ? "-24h" : `-${d}d`,
                                d === 1 ? "-1d" : `-${d}days`,
                            ].includes(spec.start)
                                ? "selected"
                                : ""
                        }
                        onClick={() => preset(d)}
                    >
                        近{d === 1 ? "24小时" : `${d}天`}
                    </button>
                ))}
            </div>
            <button
                className="range-button"
                data-testid="range-trigger"
                onClick={edit}
                title={`${dateInput(global.since, global.timezone)} — ${dateInput(global.until, global.timezone)}`}
            >
                <Icon name="clock" />
                {timeMode(spec) === "relative"
                    ? `最近 ${humanRelative(spec.start)} · 至今`
                    : timeMode(spec) === "since"
                      ? `${timeLabel(global.since, global.timezone, true)} · 至今`
                      : `${timeLabel(global.since, global.timezone)} — ${timeLabel(global.until, global.timezone)}`}
                <small>⌄</small>
            </button>
            {open && (
                <div className="modal-backdrop" onClick={close}>
                    <section
                        className="time-dialog time-editor"
                        data-testid="time-dialog"
                        role="dialog"
                        aria-label="选择时间范围"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="panel-title">
                            <h2>时间范围</h2>
                            <button
                                className="icon-button"
                                aria-label="关闭时间范围"
                                onClick={close}
                            >
                                <Icon name="close" />
                            </button>
                        </div>
                        <label className="time-mode-label">
                            范围方式
                            <select
                                data-testid="time-mode"
                                aria-label="时间范围方式"
                                value={mode}
                                onChange={(e) => {
                                    setMode(e.target.value as typeof mode);
                                    setError("");
                                }}
                            >
                                <option value="relative">
                                    最近一段时间 → 至今
                                </option>
                                <option value="since">固定起点 → 至今</option>
                                <option value="fixed">固定起止时间</option>
                            </select>
                        </label>
                        {mode === "relative" ? (
                            <label className="relative-duration">
                                相对起点
                                <input
                                    data-testid="relative-start"
                                    aria-label="相对起点"
                                    value={expression}
                                    onChange={(e) =>
                                        setExpression(e.target.value)
                                    }
                                    placeholder="-18h 或 -2days 6h"
                                    autoFocus
                                />
                                <small>
                                    例如 -18h、-2days、-1d
                                    6h。每次刷新从当下重新计算。
                                </small>
                            </label>
                        ) : (
                            <>
                                <div className="calendar-area">
                                    {mode === "fixed" ? (
                                        <DayPicker
                                            locale={zhCN}
                                            mode="range"
                                            numberOfMonths={2}
                                            selected={{
                                                from: calendarDay(start),
                                                to: calendarDay(end),
                                            }}
                                            onSelect={selectRange}
                                            defaultMonth={calendarDay(start)}
                                        />
                                    ) : (
                                        <DayPicker
                                            locale={zhCN}
                                            mode="single"
                                            selected={calendarDay(start)}
                                            onSelect={(d) => {
                                                if (d)
                                                    setStart(
                                                        `${localDay(d)}T${start.slice(11) || "00:00:00"}`,
                                                    );
                                            }}
                                            defaultMonth={calendarDay(start)}
                                        />
                                    )}
                                </div>
                                <div className="exact-time-fields">
                                    <label>
                                        开始 · {global.timezone}
                                        <input
                                            type="datetime-local"
                                            step="1"
                                            data-testid="range-start"
                                            value={start}
                                            onChange={(e) =>
                                                setStart(e.target.value)
                                            }
                                        />
                                    </label>
                                    {mode === "fixed" ? (
                                        <label>
                                            结束 · {global.timezone}
                                            <input
                                                type="datetime-local"
                                                step="1"
                                                data-testid="range-end"
                                                value={end}
                                                onChange={(e) =>
                                                    setEnd(e.target.value)
                                                }
                                            />
                                        </label>
                                    ) : (
                                        <span className="until-now">
                                            结束：至今（刷新时更新）
                                        </span>
                                    )}
                                </div>
                            </>
                        )}
                        {error && <p className="error-text">{error}</p>}
                        <div className="time-dialog-actions">
                            <button onClick={close}>取消</button>
                            <button
                                className="primary"
                                data-testid="apply-time"
                                onClick={apply}
                            >
                                应用时间范围
                            </button>
                        </div>
                    </section>
                </div>
            )}
        </div>
    );
}
