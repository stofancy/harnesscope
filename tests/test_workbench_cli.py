"""New entrypoints reuse the local service and leave legacy output separate."""

import json

import pytest

from harnesscope import cli, selfdoc


def test_web_dispatch(monkeypatch):
    calls = []
    monkeypatch.setattr("harnesscope.server.serve", lambda port: calls.append(port))
    monkeypatch.setattr("sys.argv", ["harnesscope", "--web", "--port", "9977"])
    cli._main()
    assert calls == [9977]


@pytest.mark.parametrize("args", [["--port", "9977"], ["--web", "--port", "0"],
                                  ["--web", "--port", "65536"], ["--query", "metric=tokens"]])
def test_invalid_workbench_options_stop_before_data_scan(monkeypatch, args):
    monkeypatch.setattr("sys.argv", ["harnesscope", *args])
    with pytest.raises(SystemExit):
        cli._main()


def test_analytics_uses_shared_query_and_service(monkeypatch, capsys):
    from harnesscope import service
    calls = []

    class FakeService:
        def refresh(self, background=True):
            calls.append(("refresh", background))

        def analytics(self, query):
            calls.append(("query", query.metric, query.filters, query.timezone))
            return {"summary": {"tokens": 456}, "snapshot": {"id": "fixture"}}

        def close(self):
            calls.append(("close",))

    monkeypatch.setattr(service, "UsageService", FakeService)
    monkeypatch.setattr("sys.argv", ["harnesscope", "--analytics", "--query",
                                   "harness=codex&harness=claude&metric=tokens&timezone=Asia/Singapore"])
    cli._main()
    assert json.loads(capsys.readouterr().out)["summary"]["tokens"] == 456
    assert calls == [("refresh", False),
                     ("query", "tokens", {"harness": ("codex", "claude")}, "Asia/Singapore"),
                     ("close",)]


def test_analytics_rejects_ambiguous_legacy_filters(monkeypatch):
    monkeypatch.setattr("sys.argv", ["harnesscope", "--analytics", "--since", "2026-10-01"])
    with pytest.raises(SystemExit, match="--query"):
        cli._main()


def test_schema_exposes_new_query_contract():
    result = selfdoc.schema(cli.build_parser())
    assert result["workbench"]["listen"] == "127.0.0.1"
    assert "GET /api/sessions/{harness}/{sid}" in result["workbench"]["api"]
    assert "one JSON object" in result["workbench"]["analytics_output"]
