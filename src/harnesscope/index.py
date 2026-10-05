"""Rebuildable local usage index. Harness files are always opened read-only."""

import hashlib
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, fields
from pathlib import Path
from typing import Callable, Iterable, Iterator

from .domain import (
    ParseBatch, SourceFile, TimingSample, ToolCall, TurnRecord, UsageAdapter, UsageEvent,
)

from .names import native_title

SCHEMA_VERSION = "3"
EVENT_COLUMNS = tuple(f.name for f in fields(UsageEvent))
TIMING_COLUMNS = tuple(f.name for f in fields(TimingSample))
TURN_COLUMNS = tuple(f.name for f in fields(TurnRecord))
TOOL_COLUMNS = tuple(f.name for f in fields(ToolCall))
RECORD_TABLES = (
    ("events", "event_sources", EVENT_COLUMNS),
    ("timing_samples", "timing_sources", TIMING_COLUMNS),
    ("turns", "turn_sources", TURN_COLUMNS),
    ("tool_calls", "tool_sources", TOOL_COLUMNS),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_titles (
    harness TEXT NOT NULL, session_id TEXT NOT NULL, source_file TEXT NOT NULL,
    kind TEXT NOT NULL, title TEXT, priority INTEGER NOT NULL,
    updated_us INTEGER NOT NULL, mtime_ns INTEGER NOT NULL,
    PRIMARY KEY(harness,session_id,source_file,kind)
);
CREATE INDEX IF NOT EXISTS titles_session ON session_titles(harness,session_id);
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, harness TEXT NOT NULL, source_kind TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0, mtime_ns INTEGER NOT NULL DEFAULT 0,
    inode INTEGER NOT NULL DEFAULT 0, offset INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT '{}', adapter_version TEXT NOT NULL DEFAULT '1',
    prefix_size INTEGER NOT NULL DEFAULT 0, prefix_hash TEXT NOT NULL DEFAULT '',
    boundary_hash TEXT NOT NULL DEFAULT '', last_scan_us INTEGER,
    error TEXT, warning_count INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
    key TEXT NOT NULL, timestamp_us INTEGER NOT NULL, harness TEXT NOT NULL,
    session_id TEXT NOT NULL, source_file TEXT NOT NULL,
    parent_session_id TEXT, provider TEXT, model TEXT NOT NULL, project TEXT,
    agent_type TEXT, agent_label TEXT, purpose TEXT, service_tier TEXT,
    input_net INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER,
    output INTEGER NOT NULL, reasoning INTEGER, source_total INTEGER,
    source_cost_usd TEXT, source_cost_kind TEXT, quality TEXT NOT NULL,
    extra_tokens TEXT NOT NULL DEFAULT '{}', turn_id TEXT, PRIMARY KEY (harness, key)
);
CREATE INDEX IF NOT EXISTS events_time ON events(timestamp_us);
CREATE INDEX IF NOT EXISTS events_harness_time ON events(harness, timestamp_us);
CREATE INDEX IF NOT EXISTS events_session ON events(harness, session_id, timestamp_us);
CREATE INDEX IF NOT EXISTS events_source ON events(source_file);
CREATE TABLE IF NOT EXISTS event_sources (
    harness TEXT NOT NULL, key TEXT NOT NULL, source_file TEXT NOT NULL,
    PRIMARY KEY(harness,key,source_file)
);
CREATE INDEX IF NOT EXISTS event_sources_file ON event_sources(source_file);
CREATE TABLE IF NOT EXISTS timing_samples (
    key TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL,
    start_us INTEGER NOT NULL, end_us INTEGER NOT NULL, output INTEGER NOT NULL,
    source_file TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT, turn_id TEXT,
    PRIMARY KEY (harness, key)
);
CREATE INDEX IF NOT EXISTS timing_window ON timing_samples(end_us, start_us);
CREATE INDEX IF NOT EXISTS timing_source ON timing_samples(source_file);
CREATE TABLE IF NOT EXISTS timing_sources (
    harness TEXT NOT NULL, key TEXT NOT NULL, source_file TEXT NOT NULL,
    PRIMARY KEY(harness,key,source_file)
);
CREATE INDEX IF NOT EXISTS timing_sources_file ON timing_sources(source_file);
CREATE TABLE IF NOT EXISTS turns (
    key TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    start_us INTEGER NOT NULL, end_us INTEGER, status TEXT NOT NULL, source_file TEXT NOT NULL,
    parent_session_id TEXT, root_turn_id TEXT, project TEXT, agent_type TEXT,
    boundary_quality TEXT NOT NULL, tool_coverage TEXT NOT NULL, PRIMARY KEY (harness,key)
);
CREATE INDEX IF NOT EXISTS turns_window ON turns(start_us);
CREATE INDEX IF NOT EXISTS turns_session ON turns(harness,session_id,start_us);
CREATE INDEX IF NOT EXISTS turns_identity ON turns(harness,session_id,turn_id);
CREATE INDEX IF NOT EXISTS turns_root ON turns(harness,root_turn_id);
CREATE INDEX IF NOT EXISTS turns_source ON turns(source_file);
CREATE TABLE IF NOT EXISTS turn_sources (
    harness TEXT NOT NULL, key TEXT NOT NULL, source_file TEXT NOT NULL,
    PRIMARY KEY(harness,key,source_file)
);
CREATE INDEX IF NOT EXISTS turn_sources_file ON turn_sources(source_file);
CREATE TABLE IF NOT EXISTS tool_calls (
    key TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
    start_us INTEGER NOT NULL, turn_id TEXT, end_us INTEGER, status TEXT NOT NULL,
    source_file TEXT NOT NULL, PRIMARY KEY(harness,key)
);
CREATE INDEX IF NOT EXISTS tools_window ON tool_calls(start_us);
CREATE INDEX IF NOT EXISTS tools_turn ON tool_calls(harness,session_id,turn_id,start_us);
CREATE INDEX IF NOT EXISTS tools_source ON tool_calls(source_file);
CREATE TABLE IF NOT EXISTS tool_sources (
    harness TEXT NOT NULL, key TEXT NOT NULL, source_file TEXT NOT NULL,
    PRIMARY KEY(harness,key,source_file)
);
CREATE INDEX IF NOT EXISTS tool_sources_file ON tool_sources(source_file);
"""


def _now_us() -> int:
    return time.time_ns() // 1000


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _fingerprint(path: str, offset: int, prefix_size: int | None = None) -> tuple[int, str, str]:
    """Bounded fingerprints detect replacement without hashing large transcripts."""
    prefix_size = min(4096, offset) if prefix_size is None else prefix_size
    with open(path, "rb") as source:
        prefix = source.read(prefix_size)
        source.seek(max(0, offset - 256))
        boundary = source.read(min(256, offset))
    return prefix_size, hashlib.sha256(prefix).hexdigest(), hashlib.sha256(boundary).hexdigest()


class SQLiteIndex:
    def __init__(self, path: str | os.PathLike):
        self.path = str(Path(path).expanduser().absolute())
        directory = Path(self.path).parent
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._write_lock = threading.RLock()
        with self._transaction() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
            version = conn.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
            if version and version[0] not in ("1", "2", SCHEMA_VERSION):
                raise ValueError("Usage index schema changed; remove the rebuildable usage.sqlite3 cache")
            if version and version[0] == "1":
                conn.execute("INSERT OR IGNORE INTO event_sources SELECT harness,key,source_file FROM events")
                conn.execute("INSERT OR IGNORE INTO timing_sources "
                             "SELECT harness,key,source_file FROM timing_samples")
            if version and version[0] in ("1", "2"):
                for table in ("events", "timing_samples"):
                    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
                    if "turn_id" not in columns:
                        conn.execute(f"ALTER TABLE {table} ADD COLUMN turn_id TEXT")
                # Keep old usage visible until each source is successfully reparsed.
                conn.execute("UPDATE files SET adapter_version='turn-metadata-v3'")
                conn.execute("UPDATE metadata SET value=? WHERE key='schema_version'", (SCHEMA_VERSION,))
            conn.execute("INSERT OR IGNORE INTO metadata VALUES ('schema_version', ?)",
                         (SCHEMA_VERSION,))
            conn.execute("INSERT OR IGNORE INTO metadata VALUES ('revision', '0')")
            conn.execute("INSERT OR IGNORE INTO metadata VALUES ('sources', '{}')")
            conn.execute("CREATE INDEX IF NOT EXISTS events_turn "
                         "ON events(harness,session_id,turn_id,timestamp_us)")
            conn.execute("CREATE INDEX IF NOT EXISTS timing_turn "
                         "ON timing_samples(harness,session_id,turn_id)")
            if version and version[0] in ("1", "2"):
                self._bump(conn)
        os.chmod(self.path, 0o600)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    @contextmanager
    def read_snapshot(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            conn.execute("PRAGMA query_only=ON")
            conn.execute("BEGIN")
            yield conn
        finally:
            conn.rollback()
            conn.close()

    @property
    def snapshot_id(self) -> int:
        with self.read_snapshot() as conn:
            return int(conn.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()[0])

    @staticmethod
    def _bump(conn: sqlite3.Connection) -> None:
        conn.execute("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'")

    @staticmethod
    def _clear_file(conn: sqlite3.Connection, path: str) -> None:
        conn.execute("DELETE FROM session_titles WHERE source_file=?", (path,))
        for table, owners, _columns in RECORD_TABLES:
            conn.execute(f"DELETE FROM {owners} WHERE source_file=?", (path,))
            conn.execute(f"DELETE FROM {table} WHERE source_file=? AND NOT EXISTS "
                         f"(SELECT 1 FROM {owners} WHERE {owners}.harness={table}.harness "
                         f"AND {owners}.key={table}.key)", (path,))
            conn.execute(f"UPDATE {table} SET source_file=(SELECT MIN(source_file) FROM {owners} "
                         f"WHERE {owners}.harness={table}.harness AND {owners}.key={table}.key) "
                         "WHERE source_file=?", (path,))

    @staticmethod
    def _upsert(conn: sqlite3.Connection, table: str, columns: tuple[str, ...], rows: list[dict]) -> None:
        if not rows:
            return
        # Table and column identifiers are internal constants, never request parameters.
        names = ",".join(columns)
        placeholders = ",".join("?" for _ in columns)
        updates = ",".join(f"{c}=excluded.{c}" for c in columns if c not in ("harness", "key"))
        conn.executemany(f"INSERT INTO {table} ({names}) VALUES ({placeholders}) "
                         f"ON CONFLICT(harness,key) DO UPDATE SET {updates}",
                         [tuple(row[c] for c in columns) for row in rows])

    @staticmethod
    def _store_titles(conn, source_file, mtime_ns, titles):
        for candidate in titles:
            title = native_title(candidate.title)
            # Claude's native display is customTitle || aiTitle; an empty custom
            # value removes that override. OMP's empty slot instead clears title.
            if title is None and candidate.kind in {"custom-title", "ai-title"}:
                conn.execute("DELETE FROM session_titles WHERE harness=? AND session_id=? "
                             "AND source_file=? AND kind=?",
                             (candidate.harness, candidate.session_id, source_file, candidate.kind))
                continue
            conn.execute("INSERT INTO session_titles VALUES (?,?,?,?,?,?,?,?) "
                         "ON CONFLICT(harness,session_id,source_file,kind) DO UPDATE SET "
                         "title=excluded.title,priority=excluded.priority,"
                         "updated_us=excluded.updated_us,mtime_ns=excluded.mtime_ns",
                         (candidate.harness, candidate.session_id, source_file, candidate.kind,
                          title, candidate.priority, candidate.updated_us, mtime_ns))

    def _refresh_native_titles(self, adapter):
        reader = getattr(adapter, "read_session_titles", None)
        if reader is None:
            return
        path, titles = reader()
        mtime_ns = os.stat(path).st_mtime_ns if os.path.isfile(path) else 0
        with self._write_lock, self._transaction() as conn:
            before = [tuple(row) for row in conn.execute(
                "SELECT * FROM session_titles WHERE harness=? AND kind='state' ORDER BY session_id,kind",
                (adapter.harness,))]
            conn.execute("DELETE FROM session_titles WHERE harness=? AND kind='state'", (adapter.harness,))
            self._store_titles(conn, path, mtime_ns, titles)
            after = [tuple(row) for row in conn.execute(
                "SELECT * FROM session_titles WHERE harness=? AND kind='state' ORDER BY session_id,kind",
                (adapter.harness,))]
            if before != after:
                self._bump(conn)

    def _store(self, source: SourceFile, stat: os.stat_result, batch: ParseBatch,
               rebuild: bool, adapter_version: str) -> int:
        if batch.next_offset < 0 or batch.next_offset > stat.st_size:
            raise ValueError("Adapter returned an offset outside the source file")
        event_rows = []
        for event in batch.events:
            if event.harness != source.harness:
                raise ValueError("Adapter returned usage for a different harness")
            row = asdict(event)
            row["source_file"] = source.path
            row["extra_tokens"] = _dump(row["extra_tokens"])
            event_rows.append(row)
        timing_rows = []
        for sample in batch.timing_samples:
            if sample.harness != source.harness:
                raise ValueError("Adapter returned timing for a different harness")
            row = asdict(sample)
            row["source_file"] = source.path
            timing_rows.append(row)
        turn_rows = []
        for turn in batch.turns:
            if turn.harness != source.harness:
                raise ValueError("Adapter returned a turn for a different harness")
            row = asdict(turn)
            row["source_file"] = source.path
            turn_rows.append(row)
        tool_rows = []
        for tool in batch.tool_calls:
            if tool.harness != source.harness:
                raise ValueError("Adapter returned a tool call for a different harness")
            row = asdict(tool)
            row["source_file"] = source.path
            tool_rows.append(row)
        prefix_size, prefix_hash, boundary_hash = _fingerprint(source.path, batch.next_offset)
        with self._write_lock, self._transaction() as conn:
            before = conn.execute("SELECT count(*) FROM event_sources WHERE source_file=?",
                                  (source.path,)).fetchone()[0]
            if rebuild:
                self._clear_file(conn, source.path)
            for (table, owners, columns), rows in zip(
                    RECORD_TABLES, (event_rows, timing_rows, turn_rows, tool_rows)):
                self._upsert(conn, table, columns, rows)
                conn.executemany(
                    f"INSERT OR IGNORE INTO {owners}(harness,key,source_file) VALUES (?,?,?)",
                    [(row["harness"], row["key"], source.path) for row in rows])
            self._store_titles(conn, source.path, stat.st_mtime_ns, batch.session_titles)
            count = conn.execute("SELECT count(*) FROM event_sources WHERE source_file=?",
                                 (source.path,)).fetchone()[0]
            previous = conn.execute("SELECT warning_count FROM files WHERE path=?",
                                    (source.path,)).fetchone()
            warnings = len(batch.warnings) + (previous[0] if previous and not rebuild else 0)
            conn.execute("""INSERT INTO files
                (path,harness,source_kind,size,mtime_ns,inode,offset,state,adapter_version,
                 prefix_size,prefix_hash,boundary_hash,last_scan_us,error,warning_count,event_count)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)
                ON CONFLICT(path) DO UPDATE SET harness=excluded.harness,
                source_kind=excluded.source_kind,size=excluded.size,mtime_ns=excluded.mtime_ns,
                inode=excluded.inode,offset=excluded.offset,state=excluded.state,
                adapter_version=excluded.adapter_version,prefix_size=excluded.prefix_size,
                prefix_hash=excluded.prefix_hash,boundary_hash=excluded.boundary_hash,
                last_scan_us=excluded.last_scan_us,error=NULL,
                warning_count=excluded.warning_count,event_count=excluded.event_count""",
                (source.path, source.harness, source.source_kind, stat.st_size, stat.st_mtime_ns,
                 stat.st_ino, batch.next_offset, _dump(batch.state), adapter_version,
                 prefix_size, prefix_hash, boundary_hash, _now_us(), warnings, count))
            self._bump(conn)
        return max(0, count - before)

    def _failure(self, source: SourceFile, error: Exception) -> None:
        # Exception class is sufficient for coverage; arbitrary messages may contain source text.
        with self._write_lock, self._transaction() as conn:
            conn.execute("INSERT INTO files(path,harness,source_kind,error) VALUES (?,?,?,?) "
                         "ON CONFLICT(path) DO UPDATE SET error=excluded.error",
                         (source.path, source.harness, source.source_kind, type(error).__name__))
            self._bump(conn)

    def refresh(self, adapters: Iterable[UsageAdapter], *,
                progress: Callable[[dict], None] | None = None,
                cancel: threading.Event | None = None) -> dict:
        """Discover, append or replace indexed files. Failed files retain their previous rows."""
        adapters = list(adapters)
        work: list[tuple[UsageAdapter, SourceFile]] = []
        source_status: dict[str, dict] = {}
        for adapter in adapters:
            try:
                seen = set()
                count = 0
                for item in adapter.discover():
                    source = item if isinstance(item, SourceFile) else SourceFile(str(item), adapter.harness)
                    source = SourceFile(str(Path(source.path).expanduser().absolute()), source.harness,
                                        source.source_kind, source.identity)
                    identity = source.identity or source.path
                    if identity in seen:
                        continue
                    seen.add(identity)
                    work.append((adapter, source))
                    count += 1
                source_status[adapter.harness] = {"discovered_files": count, "error": None}
            except Exception as exc:
                source_status[adapter.harness] = {"error": type(exc).__name__}
        done = added = unchanged = failed = 0
        failed_harnesses: set[str] = set()
        cancelled = False
        for adapter, source in work:
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            if progress:
                progress({"files_done": done, "files_total": len(work),
                          "current_harness": source.harness, "events_added": added})
            try:
                stat = os.stat(source.path)
                with self.read_snapshot() as conn:
                    old = conn.execute("SELECT * FROM files WHERE path=?", (source.path,)).fetchone()
                version = str(getattr(adapter, "version", "1"))
                rebuild = old is None or old["adapter_version"] != version
                if old and not rebuild:
                    changed = (stat.st_size != old["size"] or stat.st_mtime_ns != old["mtime_ns"]
                               or stat.st_ino != old["inode"])
                    if not changed and not old["error"] and old["offset"] >= old["size"]:
                        unchanged += 1
                        done += 1
                        continue
                    rebuild = (not getattr(adapter, "supports_incremental", True)
                               or stat.st_ino != old["inode"] or stat.st_size < old["size"]
                               or (changed and stat.st_size == old["size"]))
                    if not rebuild and old["offset"]:
                        _, prefix, boundary = _fingerprint(source.path, old["offset"], old["prefix_size"])
                        rebuild = prefix != old["prefix_hash"] or boundary != old["boundary_hash"]
                offset = 0 if rebuild else old["offset"]
                state = None if rebuild else json.loads(old["state"])
                batch = adapter.parse_file(source.path, offset=offset, state=state)
                if batch.next_offset < offset and not rebuild:
                    raise ValueError("Adapter moved its read position backwards")
                final_stat = os.stat(source.path)
                if final_stat.st_ino != stat.st_ino or final_stat.st_size < stat.st_size:
                    raise ValueError("Source was replaced or truncated during parsing")
                added += self._store(source, final_stat, batch, rebuild, version)
            except Exception as exc:
                failed += 1
                failed_harnesses.add(source.harness)
                self._failure(source, exc)
            done += 1
        if not cancelled:
            # Successful discovery is authoritative for this adapter's selected inputs.
            retained = {source.path for _, source in work}
            with self._write_lock, self._transaction() as conn:
                for harness, status in source_status.items():
                    if status.get("error") or harness in failed_harnesses:
                        continue
                    old_paths = conn.execute("SELECT path FROM files WHERE harness=?", (harness,)).fetchall()
                    for row in old_paths:
                        if row[0] not in retained:
                            self._clear_file(conn, row[0])
                            conn.execute("DELETE FROM files WHERE path=?", (row[0],))
                            self._bump(conn)
        if not cancelled:
            for adapter in adapters:
                try:
                    self._refresh_native_titles(adapter)
                except Exception as exc:
                    # Label availability is independent of metering completeness.
                    source_status[adapter.harness]["label_error"] = type(exc).__name__
        with self._write_lock, self._transaction() as conn:
            previous = json.loads(conn.execute("SELECT value FROM metadata WHERE key='sources'").fetchone()[0])
            previous.update(source_status)
            conn.execute("UPDATE metadata SET value=? WHERE key='sources'", (_dump(previous),))
        result = {"files_done": done, "files_total": len(work), "events_added": added,
                  "unchanged_files": unchanged, "failed_files": failed, "cancelled": cancelled,
                  "snapshot_id": self.snapshot_id, "current_harness": None}
        if progress:
            progress(result)
        return result

    def status(self) -> dict:
        with self.read_snapshot() as conn:
            revision = int(conn.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()[0])
            discovered = json.loads(conn.execute("SELECT value FROM metadata WHERE key='sources'").fetchone()[0])
            harnesses = set(discovered) | {row[0] for row in conn.execute("SELECT DISTINCT harness FROM files")}
            sources = []
            for harness in sorted(harnesses):
                row = conn.execute("""SELECT count(*) AS files, sum(warning_count) AS warnings,
                    max(last_scan_us) AS last_scan_us, sum(error IS NOT NULL) AS failed,
                    group_concat(DISTINCT error) AS error FROM files WHERE harness=?""", (harness,)).fetchone()
                events = conn.execute("SELECT count(*),max(timestamp_us) FROM events WHERE harness=?",
                                      (harness,)).fetchone()
                error = discovered.get(harness, {}).get("error") or row["error"]
                state = "partial" if error or row["warnings"] else (
                    "available" if row["files"] else "not_found")
                sources.append({"harness": harness, "state": state, "files": row["files"],
                                "events": events[0], "last_scan_us": row["last_scan_us"],
                                "latest_event_us": events[1], "warnings": row["warnings"] or 0,
                                "failed_files": row["failed"] or 0, "error": error})
            return {"snapshot_id": revision, "sources": sources}
