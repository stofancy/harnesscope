"""Native titles and display labels, independent of usage completeness and identity."""
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePosixPath


@dataclass(frozen=True)
class SessionTitle:
    harness: str
    session_id: str
    title: str | None
    kind: str
    priority: int = 0
    updated_us: int = 0


def native_title(value):
    """Only explicit native title fields are eligible; never derive from content."""
    return value.strip() if isinstance(value, str) and value.strip() else None


def project_name(path: str) -> str:
    return PurePosixPath(path).name or path


def labelled(conn, result):
    """Attach names from the same read snapshot, for rows, relations and facets.

    The first recorded request is an indexed lookup per session, not a transcript
    scan or a new aggregation of all events. A title does not become an identity.
    """
    pairs: set[tuple[str, str]] = set()
    session_ids: set[str] = set()
    projects: set[str] = set()

    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            harness, sid = value.get('harness'), value.get('session_id')
            if harness and sid:
                pairs.add((harness, sid))
                if value.get('parent_session_id'):
                    pairs.add((harness, value['parent_session_id']))
                for child in value.get('children', []):
                    pairs.add((harness, child))
            for key, item in value.items():
                if key == 'project' and isinstance(item, str) and item:
                    projects.add(item)
                elif key in ('project', 'projects') and isinstance(item, list):
                    projects.update(p for p in item if isinstance(p, str) and p)
                elif key == 'session' and isinstance(item, (str, list)):
                    session_ids.update([item] if isinstance(item, str) else item)
                walk(item)
    walk(result)
    # Facet session IDs have no harness; preserve all matching native namespaces.
    harnesses = [row[0] for row in conn.execute('SELECT DISTINCT harness FROM files')]
    pairs.update((harness, sid) for harness in harnesses for sid in session_ids if sid)
    labels = []
    for harness, sid in sorted(pairs):
        first = conn.execute('SELECT timestamp_us,project FROM events WHERE harness=? AND session_id=? '
                             'ORDER BY timestamp_us,key LIMIT 1', (harness, sid)).fetchone()
        title = conn.execute('SELECT title FROM session_titles WHERE harness=? AND session_id=? '
                             'ORDER BY priority DESC,updated_us DESC,mtime_ns DESC,source_file,kind LIMIT 1',
                             (harness, sid)).fetchone()
        if first is None:
            turn = conn.execute('SELECT project FROM turns WHERE harness=? AND session_id=? '
                                'ORDER BY start_us LIMIT 1', (harness, sid)).fetchone()
            if turn is None and title is None:
                continue
            project, stamp = (turn[0] if turn else None), None
        else:
            stamp, project = first
        if project:
            projects.add(project)
        labels.append({'harness': harness, 'session_id': sid, 'title': title[0] if title else None,
                       'project': project,
                       'first': datetime.fromtimestamp(stamp / 1e6, timezone.utc).isoformat().replace('+00:00', 'Z')
                       if stamp is not None else None})
    from .accounts import indexed_account_labels
    result['labels'] = {'sessions': labels, 'accounts': indexed_account_labels(conn),
                       'projects': [{'path': path, 'name': project_name(path)}
                                                       for path in sorted(projects)]}
    return result
