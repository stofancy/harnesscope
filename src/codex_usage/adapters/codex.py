"""Codex rollout discovery and shared legacy/native metering extraction."""

import os
from pathlib import Path

from ..domain import SourceFile
from ..parser import UUID_RE, parse_codex_file


class CodexAdapter:
    harness = "codex"

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
