import type { Account, DisplayLabels } from "./types";
import { harnessLabel, timeLabel } from "./format";

export const accountKind = (kind: string) => ({
    subscription: "订阅", api_key: "API", gateway_credential: "网关", unknown: "类型未记录",
} as Record<string, string>)[kind] ?? "类型未记录";
const shortRef = (ref: string) => ref.length > 16 ? `${ref.slice(0, 8)}…${ref.slice(-6)}` : ref;
export function accountName(account: Account) {
    return `${account.label || shortRef(account.account_ref)} · ${accountKind(account.kind)}`;
}

export const projectName = (path: string) =>
    path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "未记录项目";

export function displayNames(labels: DisplayLabels | undefined, timezone: string) {
    const sessions = new Map(
        (labels?.sessions ?? []).map((s) => [`${s.harness}:${s.session_id}`, s]),
    );
    const projects = new Map((labels?.projects ?? []).map((p) => [p.path, p.name]));
    const accounts = new Map((labels?.accounts ?? []).map(a => [a.account_ref, a]));
    function account(ref: string | null | undefined) {
        if (!ref) return "账号未知";
        const a = accounts.get(ref);
        if (!a) return `已知账号 · ${shortRef(ref)}`;
        const duplicate = (labels?.accounts ?? []).filter(other => other.label === a.label && other.kind === a.kind).length > 1;
        return `${accountName(a)}${duplicate ? ` · ${shortRef(ref)}` : ""}`;
    }
    const project = (path: string) => projects.get(path) || projectName(path);
    function session(
        harness: string,
        id: string,
        fallback: { project?: string | null; first?: string | null } = {},
    ) {
        const metadata = sessions.get(`${harness}:${id}`);
        if (metadata?.title) return metadata.title;
        const path = metadata?.project || fallback.project;
        const first = metadata?.first || fallback.first;
        return [
            path ? project(path) : "未记录项目",
            first ? timeLabel(first, timezone, true) : harnessLabel(harness),
            "未命名会话",
        ].filter(Boolean).join(" · ");
    }
    function facetSession(id: string, harness?: string) {
        const matches = (labels?.sessions ?? []).filter(
            (s) => s.session_id === id && (!harness || s.harness === harness),
        );
        return matches.length
            ? matches.map((s) => `${session(s.harness, id)} · ${harnessLabel(s.harness)}`).join(" / ")
            : "未命名会话";
    }
    function sessionTooltip(harness: string, id: string) {
        const s = sessions.get(`${harness}:${id}`);
        return [s?.title, `${harnessLabel(harness)} · ${id}`, s?.project].filter(Boolean).join("\n");
    }
    return { project, session, facetSession, sessionTooltip, account };
}
