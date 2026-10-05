import type { Analysis } from "./types";
import { exactNumber, formatNumber } from "./format";
import "./insights.css";

export function TokenComposition({ data }: { data: Analysis }) {
    const summary = data.summary;
    const writeUnknown = summary.input_complete === false || summary.cache_write == null;
    const parts = [
        { key: "input", label: "输入（未缓存）", amount: summary.input_net ?? null, unknown: summary.input_net == null },
        { key: "cache_read", label: "缓存命中", amount: summary.cache_read, unknown: false },
        { key: "output", label: "输出", amount: summary.output, unknown: false },
        { key: "cache_write", label: "缓存写入", amount: summary.cache_write ?? summary.cache_write_known ?? null, unknown: writeUnknown },
    ];
    const recorded = parts.reduce((total, part) => total + (part.amount ?? 0), 0);
    const partial = parts.some((part) => part.unknown);
    return (
        <section className="token-composition" data-testid="token-composition" aria-labelledby="token-composition-title">
            <header className="token-composition-heading">
                <div>
                    <h2 id="token-composition-title">Token 构成</h2>
                </div>
                <div className="token-composition-total" title={`${exactNumber(summary.tokens)} Tokens${partial ? " · 部分数据" : ""}`}>
                    <strong>{formatNumber(summary.tokens)}{partial ? "*" : ""}</strong><span> Tokens</span>
                </div>
            </header>
            <div className={`token-component-bar${recorded === 0 ? " empty" : ""}`}
                data-testid="token-component-bar" role="img"
                aria-label={parts.map(part => `${part.label} ${part.amount == null ? "—" : exactNumber(part.amount)}${part.unknown && part.amount != null ? "*" : ""}`).join("；")}>
                {parts.map((part) => part.amount != null && part.amount > 0 && recorded > 0 ? <span
                    key={part.key} className={`token-segment token-color-${part.key}`}
                    style={{ width: `${part.amount / recorded * 100}%` }}
                    data-part={part.key} data-value={part.amount}
                    title={`${part.label} ${exactNumber(part.amount)} Tokens${part.unknown ? " · 部分数据" : ""}`} /> : null)}
            </div>
            <div className="token-composition-parts">
                {parts.map((part) => <div key={part.key} className="token-part"
                    data-testid={`token-part-${part.key}`} data-value={part.amount ?? "unknown"}
                    data-unknown={part.unknown}>
                    <div className="token-part-label"><i className={`token-color-${part.key}`} />{part.label}</div>
                    <div className="token-part-number" title={`${part.amount == null ? "未知" : exactNumber(part.amount)} Tokens${part.unknown ? " · 部分数据" : ""}`}>
                        <strong>{part.amount == null ? "—" : `${formatNumber(part.amount)}${part.unknown ? "*" : ""}`}</strong>
                    </div>
                </div>)}
            </div>
        </section>
    );
}
