"""Metadata-only turn and tool ledger for transcript adapters."""

from dataclasses import asdict

from ..domain import ToolCall, TurnRecord


class ConversationLedger:
    """Resolve message ancestry without retaining content, arguments, or results."""

    def __init__(self, harness, path, state=None):
        state = state or {}
        self.harness = harness
        self.path = path
        self.nodes = dict(state.get("nodes", {}))
        self.active = dict(state.get("active", {}))
        self.turns = {key: dict(value) for key, value in state.get("turns", {}).items()}
        self.tools = {key: dict(value) for key, value in state.get("tools", {}).items()}
        self.last = dict(state.get("last", {}))
        self.uncertain = dict(state.get("uncertain", {}))
        self.changed_turns: set[str] = set()
        self.changed_tools: set[str] = set()

    @staticmethod
    def turn_key(session_id, turn_id):
        return f"{session_id}:turn:{turn_id}"

    def start(self, session_id, turn_id, when, *, parent=None, project=None,
              agent_type=None, quality="inferred"):
        key = self.turn_key(session_id, turn_id)
        if key not in self.turns:
            self.turns[key] = asdict(TurnRecord(
                key=key, harness=self.harness, session_id=session_id, turn_id=turn_id,
                start_us=when, status="running", source_file=self.path,
                parent_session_id=parent, project=project, agent_type=agent_type,
                boundary_quality=quality))
        self.active[session_id] = turn_id
        self.last[key] = max(when, self.last.get(key, when))
        self.changed_turns.add(key)

    def observe_node(self, session_id, node_id, parent_id, when, *, user=False,
                     parent=None, project=None, agent_type=None):
        node_key = f"{session_id}:{node_id}" if node_id else None
        existing = self.nodes.get(node_key) if node_key else None
        turn_id: str | None = None
        if user and node_id and when is not None:
            turn_id = str(node_id)
            if existing is None:
                previous = self.active.get(session_id)
                previous_key = self.turn_key(session_id, previous) if previous else None
                if previous_key in self.turns and self.turns[previous_key]["end_us"] is None:
                    # A new prompt proves a boundary, but does not prove that the
                    # previous turn completed rather than being interrupted.
                    self.finish(session_id, previous, self.last.get(previous_key), "unknown")
                self.start(session_id, turn_id, when, parent=parent,
                           project=project, agent_type=agent_type)
        elif node_key and node_key in self.nodes:
            turn_id = self.nodes[node_key]
        elif parent_id:
            turn_id = self.nodes.get(f"{session_id}:{parent_id}")
        else:
            # Older linear transcripts lack message-chain IDs. Their chronological
            # association remains explicitly inferred by the user boundary.
            turn_id = self.active.get(session_id)
        if node_key:
            self.nodes[node_key] = turn_id
        if turn_id is not None and when is not None:
            self.touch(session_id, turn_id, when)
        return turn_id

    def touch(self, session_id, turn_id, when):
        key = self.turn_key(session_id, turn_id)
        if key in self.turns and when is not None:
            self.last[key] = max(when, self.last.get(key, when))
            self.changed_turns.add(key)

    def finish(self, session_id, turn_id, when, status):
        key = self.turn_key(session_id, turn_id)
        if key not in self.turns or when is None:
            return
        self.turns[key]["end_us"] = max(when, self.turns[key]["start_us"])
        self.turns[key]["status"] = status
        self.touch(session_id, turn_id, when)

    def call(self, session_id, call_id, name, when, turn_id=None):
        if not call_id or not name or when is None:
            self.mark_uncertain(session_id, turn_id)
            return
        key = f"{session_id}:tool:{call_id}"
        if key not in self.tools:
            self.tools[key] = asdict(ToolCall(
                key=key, harness=self.harness, session_id=session_id, tool_name=name,
                start_us=when, turn_id=turn_id, status="running", source_file=self.path))
        else:
            self.tools[key]["start_us"] = min(when, self.tools[key]["start_us"])
        self.changed_tools.add(key)
        self.touch(session_id, turn_id, when)

    def result(self, session_id, call_id, when, error=False, turn_id=None):
        key = f"{session_id}:tool:{call_id}" if call_id else None
        if key is None or key not in self.tools or when is None:
            self.mark_uncertain(session_id, turn_id)
            return
        tool = self.tools[key]
        tool["end_us"] = max(when, tool["start_us"])
        tool["status"] = "error" if error else "completed"
        self.changed_tools.add(key)
        self.touch(session_id, tool["turn_id"], when)

    def mark_uncertain(self, session_id, turn_id):
        if turn_id is not None:
            key = self.turn_key(session_id, turn_id)
            self.uncertain[key] = True
            self.changed_turns.add(key)

    def flush(self, batch, structurally_complete=True):
        for key in self.changed_turns:
            turn = self.turns.get(key)
            if not turn:
                continue
            tools = [tool for tool in self.tools.values() if
                     tool["session_id"] == turn["session_id"] and
                     tool["turn_id"] == turn["turn_id"]]
            complete = (structurally_complete and not self.uncertain.get(key) and
                        turn["end_us"] is not None and turn["status"] != "unknown" and
                        all(tool["end_us"] is not None for tool in tools))
            turn["tool_coverage"] = "complete" if complete else "unknown"
            batch.turns.append(TurnRecord(**turn))
        batch.tool_calls.extend(ToolCall(**self.tools[key]) for key in self.changed_tools)
        return {"nodes": self.nodes, "active": self.active, "turns": self.turns,
                "tools": self.tools, "last": self.last, "uncertain": self.uncertain}
