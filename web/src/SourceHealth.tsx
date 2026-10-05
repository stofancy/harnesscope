import type { Source } from "./types";
import { harnessLabel } from "./format";

export function SourceHealth({ sources }: { sources: Source[] }) {
    return (
        <details className="source-health" data-testid="source-health">
            <summary>
                数据来源 <span>{sources.length} 个本机来源</span>
            </summary>
            <div className="sources-grid">
                {sources.map((s) => (
                    <article key={s.harness} data-testid={`source-${s.harness}`}>
                        <header>
                            <b>{harnessLabel(s.harness)}</b>
                            <span className={`source-state ${s.state}`}>
                                {{ ready: "已读取", partial: "部分数据", missing: "未发现",
                                    error: "读取失败", scanning: "读取中" }[s.state]}
                            </span>
                        </header>
                        <p>{s.files} 个文件 · {s.events} 条可用记录</p>
                        {s.warnings.map((w, i) => <small key={i}>{w}</small>)}
                        {s.warning_details?.map((issue) => (
                            <div className="source-issue" key={issue.code}
                                data-testid={`source-issue-${issue.code}`}>
                                <b>{issue.label}</b>
                                <small>{issue.count} 条提示 · {issue.affected_files} 个文件</small>
                                <p>{issue.impact}</p>
                                <details>
                                    <summary>处理建议与文件</summary>
                                    <p>{issue.action}</p>
                                    <ul className="source-issue-files">
                                        {issue.files.map((file) => (
                                            <li key={file.path}>
                                                <span title={file.path}>{file.name}</span>
                                                <small>{file.count} 条提示
                                                    {file.byte_offsets.length > 0 &&
                                                        ` · 字节位置 ${file.byte_offsets.join("、")}`}
                                                    {file.locations_omitted > 0 &&
                                                        ` · 另 ${file.locations_omitted} 个位置`}
                                                </small>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            </div>
                        ))}
                        {s.state === "missing" && <p>当前配置的来源目录没有可读取的会话文件。确认目录配置及该工具是否已产生本机记录，再刷新。</p>}
                    </article>
                ))}
            </div>
        </details>
    );
}
