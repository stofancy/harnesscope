import type { DisplayLabels } from "./types";
import { harnessLabel, timeLabel } from "./format";

export const projectName = (path: string) =>
    path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "未记录项目";

export function displayNames(labels: DisplayLabels | undefined, timezone: string) {
    const sessions = new Map(
        (labels?.sessions ?? []).map((s) => [`${s.harness}:${s.session_id}`, s]),
    );
    const projects = new Map((labels?.projects ?? []).map((p) => [p.path, p.name]));
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
    return { project, session, facetSession, sessionTooltip };
}
