"""Shared local service for the CLI and browser; refresh runs independently of queries."""

import threading
from pathlib import Path
from typing import Iterable

from . import config
from .domain import UsageAdapter
from .index import SQLiteIndex


class UsageService:
    def __init__(self, index_path: str | Path | None = None,
                 adapters: Iterable[UsageAdapter] | None = None, query=None):
        self.index = SQLiteIndex(index_path or Path(config.cache_dir()) / "usage.sqlite3")
        if adapters is None:
            from .adapters import get_adapters
            adapters = get_adapters()
        self.adapters = list(adapters)
        self._query = query
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._refreshing = False
        self._cancel = threading.Event()
        self._progress: dict = {"files_done": 0, "files_total": 0,
                                "current_harness": None, "events_added": 0}
        self._last_refresh_error: str | None = None

    def _on_progress(self, value: dict) -> None:
        with self._lock:
            self._progress = dict(value)

    def _run_refresh(self) -> None:
        try:
            self.index.refresh(self.adapters, progress=self._on_progress, cancel=self._cancel)
        except Exception as exc:
            with self._lock:
                self._last_refresh_error = type(exc).__name__
        finally:
            with self._lock:
                self._refreshing = False

    def refresh(self, background: bool = True) -> dict:
        with self._lock:
            if self._refreshing:
                return {"started": False, "refreshing": True,
                        "snapshot_id": self.index.snapshot_id}
            self._refreshing = True
            self._last_refresh_error = None
            self._cancel.clear()
            self._progress = {"files_done": 0, "files_total": 0,
                              "current_harness": None, "events_added": 0}
            if background:
                self._thread = threading.Thread(target=self._run_refresh,
                                                name="usage-refresh", daemon=True)
                self._thread.start()
        if not background:
            self._run_refresh()
        return {"started": True, "refreshing": self.refreshing,
                "snapshot_id": self.index.snapshot_id}

    @property
    def refreshing(self) -> bool:
        with self._lock:
            return self._refreshing

    def status(self) -> dict:
        result = self.index.status()
        with self._lock:
            result.update(refreshing=self._refreshing, progress=dict(self._progress),
                          last_refresh_error=self._last_refresh_error)
        return result

    def cancel_refresh(self) -> None:
        self._cancel.set()

    def close(self) -> None:
        self.cancel_refresh()
        with self._lock:
            thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=5)

    def _queries(self):
        if self._query is None:
            from .query import AnalyticsQuery
            self._query = AnalyticsQuery(self.index)
        return self._query

    def analytics(self, request):
        return self._queries().analytics(request)

    def sessions(self, request, offset: int = 0, limit: int = 50):
        return self._queries().sessions(request, offset=offset, limit=limit)

    def session_detail(self, harness: str, sid: str, request=None):
        return self._queries().session_detail(harness, sid, request)
