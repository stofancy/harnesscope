import { useEffect, useRef, useState } from "react";
import { analyze, dashboard, turns, type Dashboard } from "./api";
import type {
    Dimension,
    GlobalQuery,
    Metric,
    PanelConfig,
    PanelId,
} from "./types";
import type { TurnView } from "./preferences";
type Part = PanelId | "ledger" | "turns";
const angle = (c: {
    dimension: Dimension;
    metric: Metric;
    members?: string[];
}) =>
    JSON.stringify({
        dimension: c.dimension,
        metric: c.metric,
        members: c.members ?? [],
    });
export function useDashboard(
    global: GlobalQuery,
    panels: Record<PanelId, PanelConfig>,
    ledger: { dimension: Dimension; metric: Metric },
    offset: number,
    turnView: TurnView,
    revision: number,
) {
    const [data, setData] = useState<Dashboard | null>(null),
        [pending, setPending] = useState<Part[]>([]),
        [errors, setErrors] = useState<
            Partial<Record<Part | "global", string>>
        >({}),
        [retry, setRetry] = useState(0);
    const dataRef = useRef(data),
        loaded = useRef<Record<string, string>>({}),
        forceFull = useRef(false),
        lastRevision = useRef(revision);
    dataRef.current = data;
    const globalKey = JSON.stringify(global);
    const keys: Record<Part, string> = {
        consumption: angle(panels.consumption),
        rate: angle(panels.rate),
        cache: angle(panels.cache),
        speed: angle(panels.speed),
        ledger: angle(ledger),
        turns: JSON.stringify({
            offset,
            sort: turnView.sort,
            order: turnView.order,
        }),
    };
    const localKey = JSON.stringify(keys);
    useEffect(() => {
        const c = new AbortController();
        const full =
            !dataRef.current ||
            JSON.stringify(dataRef.current.global) !== globalKey ||
            lastRevision.current !== revision ||
            forceFull.current;
        lastRevision.current = revision;
        forceFull.current = false;
        const dirty = (Object.keys(keys) as Part[]).filter(
            (id) => full || loaded.current[id] !== keys[id],
        );
        setPending(dirty);
        setErrors((old) =>
            full
                ? {}
                : Object.fromEntries(
                      Object.entries(old).filter(
                          ([id]) => !dirty.includes(id as Part),
                      ),
                  ),
        );
        if (full) {
            dashboard(global, panels, ledger, offset, c.signal, {
                sort: turnView.sort,
                order: turnView.order,
            })
                .then((result) => {
                    if (c.signal.aborted) return;
                    loaded.current = { ...keys };
                    dataRef.current = result;
                    setData(result);
                    setPending([]);
                })
                .catch((e) => {
                    if (!c.signal.aborted) {
                        setErrors({ global: e.message });
                        setPending([]);
                    }
                });
        } else {
            for (const id of dirty) {
                const task =
                    id === "turns"
                        ? turns(global, offset, c.signal, {
                              sort: turnView.sort,
                              order: turnView.order,
                          })
                        : analyze(
                              {
                                  ...global,
                                  ...(id === "ledger" ? ledger : panels[id]),
                              },
                              c.signal,
                          );
                task.then((result) => {
                    if (c.signal.aborted) return;
                    if (result.snapshot_id !== dataRef.current?.snapshot_id) {
                        c.abort();
                        forceFull.current = true;
                        setRetry((n) => n + 1);
                        return;
                    }
                    loaded.current[id] = keys[id];
                    setData((previous) => {
                        if (!previous) return previous;
                        const next =
                            id === "turns"
                                ? {
                                      ...previous,
                                      turns: result as Dashboard["turns"],
                                  }
                                : id === "ledger"
                                  ? {
                                        ...previous,
                                        ledger: result as Dashboard["ledger"],
                                    }
                                  : {
                                        ...previous,
                                        panels: {
                                            ...previous.panels,
                                            [id]: result,
                                        },
                                    };
                        dataRef.current = next;
                        return next;
                    });
                    setPending((p) => p.filter((part) => part !== id));
                }).catch((e) => {
                    if (!c.signal.aborted) {
                        setErrors((old) => ({ ...old, [id]: e.message }));
                        setPending((p) => p.filter((part) => part !== id));
                    }
                });
            }
        }
        return () => c.abort();
    }, [globalKey, localKey, revision, retry]);
    const globalUpdating =
        !data ||
        JSON.stringify(data.global) !== globalKey ||
        pending.length === 6;
    return {
        data,
        pending,
        errors,
        globalUpdating,
        retry: (part?: Part) => {
            if (part) delete loaded.current[part];
            else forceFull.current = true;
            setRetry((n) => n + 1);
        },
    };
}
