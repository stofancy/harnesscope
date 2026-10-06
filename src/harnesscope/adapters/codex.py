"""Codex rollout discovery and shared legacy/native metering extraction."""

from contextlib import closing
import os
import sqlite3
from pathlib import Path

from ..domain import SourceFile
from ..parser import UUID_RE, parse_codex_file
from ..names import SessionTitle


class CodexAdapter:
    harness = "codex"
    version = "5"

    def __init__(self, root: str | Path | None = None):
        self.root = Path(root or os.environ.get("CODEX_HOME") or Path.home() / ".codex")

    def discover(self):
        # Prefer active files over archive copies; keep different pagination pages.
        identities = set()
        for directory in (self.root / "sessions", self.root / "archived_sessions"):
            for path in sorted(directory.rglob("rollout-*.jsonl")):
                ids = UUID_RE.findall(path.name)
                if not ids:
                    continue
                identity = path.name
                if identity in identities:
                    continue
                identities.add(identity)
                yield SourceFile(str(path), self.harness, identity=identity)

    def parse_file(self, path, offset=0, state=None):
        return parse_codex_file(str(path), offset, state)

    def read_session_titles(self):
        """Native thread projection; mode=ro never creates or writes the source DB."""
        path = (self.root / "state_5.sqlite").absolute()
        if not path.is_file():
            return str(path), []
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)) as conn:
            conn.execute("PRAGMA query_only=ON")
            titles = [SessionTitle(self.harness, row[0], row[1], "state", 100)
                      for row in conn.execute("SELECT id,title FROM threads")]
        return str(path), titles
