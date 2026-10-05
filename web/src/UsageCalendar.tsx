import { useMemo, useState, type CSSProperties } from "react";
import type { Analysis, GlobalQuery, Point } from "./types";
import type { CalendarMetric } from "./preferences";
import { dateInput, inputDate, formatNumber } from "./format";
import type { TimeSpec } from "./time";
import "./calendar.css";

const DAY = 86400000;
const labels: Record<CalendarMetric, string> = {
    tokens: "Tokens", cost: "估算费用", calls: "已记录调用",
};
const exact = (n: number) => new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 12,
}).format(n);
const valueLabel = (n: number | null, metric: CalendarMetric) =>
    n == null ? "—" : `${metric === "cost" ? "$" : ""}${exact(n)}`;
const nominalDate = (time: number) => new Date(time).toISOString().slice(0, 10);

export function calendarYearRange(year: number, timezone: string): {
    timeSpec: TimeSpec; window: { since: string; until: string };
} {
    const now = new Date();
    const thisYear = Number(dateInput(now.toISOString(), timezone).slice(0, 4));
    if (year > thisYear) throw new Error("不能选择未来年份");
    const since = inputDate(`${year}-01-01T00:00:00`, timezone);
    const end = year === thisYear ? "now" : inputDate(`${year + 1}-01-01T00:00:00`, timezone);
    return { timeSpec: { start: since, end }, window: { since, until: end === "now" ? now.toISOString() : end } };
}

type Day = {
    date: string; point?: Point; value: number | null;
    state: "empty" | "available" | "partial" | "unknown" | "future" | "outside" | "padding" | "unavailable";
    level: number; since: string; until: string;
};

export function UsageCalendar({ data, global, metric, onMetric, onYear, onDay }: {
    data: Analysis; global: GlobalQuery; metric: CalendarMetric;
    onMetric: (m: CalendarMetric) => void;
    onYear: (year: number) => void;
    onDay: (since: string, until: string) => void;
}) {
    const year = Number(dateInput(global.since, global.timezone).slice(0, 4));
    const today = dateInput(new Date().toISOString(), global.timezone).slice(0, 10);
    const currentYear = Number(today.slice(0, 4));
    const daily = (data.bucket_resolved ?? data.query.bucket) === "day";
    const [hover, setHover] = useState<{ day: Day; x: number; y: number } | null>(null);
    const calendar = useMemo(() => {
        // Nominal UTC dates are used only for grid positions. Day boundaries below
        // are resolved in the query timezone, including its daylight-saving changes.
        const first = Date.UTC(year, 0, 1), last = Date.UTC(year, 11, 31);
        const offset = (new Date(first).getUTCDay() + 6) % 7;
        const gridStart = first - offset * DAY;
        const weeks = Math.ceil(((last - gridStart) / DAY + 1) / 7);
        const points = new Map(data.trend.map(p => [dateInput(p.start, global.timezone).slice(0, 10), p]));
        const maximum = daily ? Math.max(0, ...data.trend.map(p => p.total[metric] ?? 0)) : 0;
        const days: Day[] = Array.from({ length: weeks * 7 }, (_, i) => {
            const t = gridStart + i * DAY, date = nominalDate(t);
            const point = daily ? points.get(date) : undefined;
            const since = inputDate(`${date}T00:00:00`, global.timezone);
            const until = inputDate(`${nominalDate(t + DAY)}T00:00:00`, global.timezone);
            const value = point?.total[metric] ?? null;
            let state: Day["state"];
            if (t < first || t > last) state = "padding";
            else if (date > today) state = "future";
            else if (since >= global.until || until <= global.since) state = "outside";
            else if (!point) state = "unavailable";
            else if (point.total.calls === 0) state = "empty";
            else if (value == null) state = "unknown";
            else if ((metric === "cost" && (point.total.cost_complete === false || point.total.unpriced > 0)) ||
                (metric === "tokens" && point.total.input_complete === false)) state = "partial";
            else state = "available";
            return { date, point, value, state, since, until,
                level: value != null && value > 0 && maximum > 0 ? Math.min(4, Math.ceil(value / maximum * 4)) : 0 };
        });
        const months = Array.from({ length: 12 }, (_, month) => ({
            label: `${month + 1}月`, column: Math.floor((Date.UTC(year, month, 1) - gridStart) / DAY / 7) + 1,
        }));
        return { days, weeks, months, maximum };
    }, [data, global, metric, year, today, daily]);
    function showDay(day: Day, target: HTMLElement) {
        const body = target.closest(".calendar-body")!.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        setHover({ day, x: Math.max(0, Math.min(rect.left - body.left, body.width - 276)), y: rect.bottom - body.top + 8 });
    }
    const selected = hover ? calendar.days.find(day => day.date === hover.day.date) : undefined;
    return <section className="panel usage-calendar" data-testid="usage-calendar">
        <header className="calendar-heading">
            <div className="calendar-year-controls">
                <button data-testid="calendar-prev-year" aria-label="上一年" onClick={() => onYear(year - 1)}>‹</button>
                <h3 data-testid="calendar-year">{year} 年用量</h3>
                <button data-testid="calendar-next-year" aria-label="下一年" disabled={year >= currentYear} onClick={() => onYear(year + 1)}>›</button>
                {year !== currentYear && <button className="text-button" data-testid="calendar-this-year" onClick={() => onYear(currentYear)}>今年</button>}
                <span className="calendar-scope">{year === currentYear ? "今年截至现在" : "完整自然年"} · 本机自然日</span>
            </div>
            <div className="segmented calendar-metrics">
                {(["tokens", "cost", "calls"] as CalendarMetric[]).map(m => <button key={m}
                    data-testid={`calendar-metric-${m}`} className={m === metric ? "selected" : ""}
                    onClick={() => { setHover(null); onMetric(m); }}>{labels[m]}</button>)}
            </div>
        </header>
        {!daily ? <div className="calendar-loading">正在准备逐日用量…</div> : <>
            <div className="calendar-body" onMouseLeave={() => setHover(null)} style={{ "--calendar-weeks": calendar.weeks } as CSSProperties}>
                <div className="calendar-months">{calendar.months.map(m => <span key={m.label} style={{ gridColumn: m.column }}>{m.label}</span>)}</div>
                <div className="calendar-weekdays">{["一", "二", "三", "四", "五", "六", "日"].map(d => <span key={d}>{d}</span>)}</div>
                <div className="calendar-grid">
                    {calendar.days.map(day => <button key={day.date} data-date={day.date} data-state={day.state} data-level={day.level}
                        className="calendar-day" disabled={["future", "outside", "padding", "unavailable"].includes(day.state)}
                        aria-label={`${day.date} ${labels[metric]} ${valueLabel(day.value, metric)}${day.state === "partial" ? "，部分已记录小计" : day.state === "unknown" ? "，费用未知" : day.state === "empty" ? "，无已记录调用" : ""}`}
                        onMouseEnter={e => showDay(day, e.currentTarget)} onFocus={e => showDay(day, e.currentTarget)}
                        onBlur={() => setHover(null)} onClick={() => onDay(day.since, day.until)} />)}
                </div>
                {selected && <div className="calendar-tooltip" role="tooltip" data-testid="calendar-tooltip" style={{ left: hover?.x, top: hover?.y }}>
                    <strong>{selected.date}</strong>
                    {selected.point ? <>
                        <dl><div><dt>Tokens</dt><dd>{exact(selected.point.total.tokens)}{selected.point.total.input_complete === false ? " · 已记录小计" : ""}</dd></div>
                            <div><dt>估算费用</dt><dd>{valueLabel(selected.point.total.cost, "cost")}</dd></div>
                            <div><dt>已记录调用</dt><dd>{exact(selected.point.total.calls)}</dd></div></dl>
                        <p>{selected.point.total.calls === 0 ? "无已记录调用" : selected.point.total.cost == null ? "全部调用无法估价，费用未知" : selected.point.total.unpriced > 0 || selected.point.total.cost_complete === false ? `已知费用小计 · ${selected.point.total.unpriced} 次调用无法估价` : "按已记录调用估算费用"}</p>
                        {selected.point.total.input_complete === false && <p>输入组成有缺口，Tokens 为已记录小计</p>}
                        {(selected.point.window_start && selected.point.window_start !== selected.point.start || selected.point.window_end && selected.point.window_end !== selected.point.end) && <p>仅包含全局范围内的当日用量</p>}
                    </> : <p>{selected.state === "future" ? "未来日期" : selected.state === "outside" ? "不在当前时间范围内" : "无可用逐日数据"}</p>}
                </div>}
            </div>
            <footer className="calendar-footer">
                <span>{metric === "cost" ? "按已知估算费用着色" : `按每日${labels[metric]}着色`}</span>
                <div className="calendar-legend"><span>0</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} title={level === 0 ? "0" : `≤ ${valueLabel(calendar.maximum * level / 4, metric)}`} />)}
                    <span>{metric === "cost" ? valueLabel(calendar.maximum, metric) : formatNumber(calendar.maximum)}</span>
                    <i data-state="partial" /><span>部分覆盖</span><i data-state="unknown" /><span>未知</span><i data-state="future" /><span>未来</span></div>
            </footer>
        </>}
    </section>;
}
