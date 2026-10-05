import type { Analysis, Member, PanelConfig, Dimension, Metric } from "./types";
import { dimensions, value } from "./components";
import { formatMetric, metricLabels } from "./format";
export function AbsoluteRanking({
    data,
    config,
    onConfig,
    onSelect,
}: {
    data: Analysis;
    config: PanelConfig;
    onConfig: (c: PanelConfig) => void;
    onSelect: (m: Member) => void;
}) {
    const metric = data.query.metric;
    const rows = [...data.members]
        .sort(
            (a, b) =>
                (value(b.values, metric) ?? -Infinity) -
                (value(a.values, metric) ?? -Infinity),
        )
        .filter((r) => r.values.calls > 0)
        .slice(0, 6);
    const peak = Math.max(0, ...rows.map((r) => value(r.values, metric) ?? 0));
    return (
        <aside
            className="absolute-ranking panel"
            data-testid="absolute-ranking"
        >
            <header>
                <h2>{metricLabels[metric]}排行</h2>
                <span>当前时段</span>
            </header>
            <div className="rank-dimensions">
                {(["model", "harness", "project", "account"] as Dimension[]).map((d) => (
                    <button
                        key={d}
                        data-testid={`rank-group-${d}`}
                        className={config.dimension === d ? "selected" : ""}
                        onClick={() =>
                            onConfig({ ...config, dimension: d, members: [] })
                        }
                    >
                        {dimensions[d]}
                    </button>
                ))}
            </div>
            <div className="rank-rows">
                {rows.map((m, i) => (
                    <button
                        key={m.key}
                        className="rank-row"
                        data-testid="rank-row"
                        title={`筛选${m.label}并查看其请求\n${m.tooltip ?? m.label}`}
                        onClick={() => onSelect(m)}
                    >
                        <span className="rank-position">{i + 1}</span>
                        <span className="rank-name" title={m.tooltip ?? m.label}>
                            {m.label}
                        </span>
                        <b>
                            {formatMetric(value(m.values, metric), metric)}
                            {metric === "cost" && m.values.unpriced > 0
                                ? " *"
                                : ""}
                        </b>
                        <i
                            style={{
                                width: `${peak ? Math.max(0, (value(m.values, metric) ?? 0) / peak) * 100 : 0}%`,
                            }}
                        />
                    </button>
                ))}
            </div>
            {!rows.length && <p className="empty">当前范围没有已记录用量</p>}
            <footer>{rows.length} 个主要对象 · 点击查看请求</footer>
        </aside>
    );
}
