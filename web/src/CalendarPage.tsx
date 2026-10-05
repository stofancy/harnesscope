import { useEffect, useMemo, useState } from "react";
import { calendar } from "./api";
import { Icon } from "./components";
import type { CalendarAnalysis, GlobalQuery } from "./types";
import type { CalendarMetric } from "./preferences";
import { UsageCalendar, calendarYearRange } from "./UsageCalendar";

export function CalendarPage({ year, metric, timezone, revision, scanning, onYear, onMetric, onRefresh, onDay }: {
    year: number;
    metric: CalendarMetric;
    timezone: string;
    revision: number;
    scanning: boolean;
    onYear: (year: number) => void;
    onMetric: (metric: CalendarMetric) => void;
    onRefresh: () => void;
    onDay: (since: string, until: string) => void;
}) {
    const [data, setData] = useState<CalendarAnalysis | null>(null);
    const [pending, setPending] = useState(true);
    const [error, setError] = useState("");
    const [loadedKey, setLoadedKey] = useState("");
    const key = JSON.stringify({ year, timezone, revision });
    const query = useMemo<GlobalQuery>(() => ({
        ...calendarYearRange(year, timezone), timezone, bucket: "day", filters: {},
    }), [year, timezone, revision]);
    useEffect(() => {
        const controller = new AbortController();
        setPending(true);
        setError("");
        calendar(year, timezone, controller.signal).then(result => {
            if (controller.signal.aborted) return;
            setData(result);
            setLoadedKey(key);
            setPending(false);
        }).catch(e => {
            if (!controller.signal.aborted) {
                setError(e.message);
                setPending(false);
            }
        });
        return () => controller.abort();
    }, [key]);
    const current = !pending && loadedKey === key ? data : null;
    return <div className="calendar-page" data-testid="calendar-page" aria-busy={pending}>
        {error && <p className="error-banner">{error}</p>}
        <UsageCalendar data={current} global={current?.query ?? query}
            loading={pending} metric={metric} onMetric={onMetric} onYear={onYear} onDay={onDay}
            actions={<button data-testid="calendar-refresh" disabled={scanning} onClick={onRefresh}>
                <Icon name="refresh" /> {scanning ? "刷新中…" : "刷新"}
            </button>} />
    </div>;
}
