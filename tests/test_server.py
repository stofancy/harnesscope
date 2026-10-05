"""HTTP boundaries use isolated static files and an injected, scan-free service."""

import pytest
from starlette.testclient import TestClient

from harnesscope.server import create_app


class FakeService:
    def __init__(self):
        self.refreshes = 0
        self.closed = False

    def status(self):
        return {"snapshot_id": "1", "refreshing": False, "sources": []}

    def refresh(self, *, background=True):
        assert background
        self.refreshes += 1
        return {"started": True, "refreshing": True, "snapshot_id": "1"}

    def analytics(self, query):
        return {"snapshot": {"id": "1"}, "summary": {"calls": 3}}

    def sessions(self, query, offset=0, limit=50):
        return {"sessions": [], "total": 0, "offset": offset, "limit": limit}

    def session_detail(self, harness, sid, request=None):
        return {"session": {"harness": harness, "session_id": sid}} if sid == "present" else None

    def close(self):
        self.closed = True


@pytest.fixture
def web(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html><body>本机工作台</body></html>")
    (static / "app.js").write_text("console.log('local')")
    service = FakeService()
    with TestClient(create_app(service, static_dir=static),
                    base_url="http://127.0.0.1:8765") as client:
        yield client, service, static
    assert service.closed


def test_startup_scan_and_gets_are_read_only(web):
    client, service, _ = web
    assert service.refreshes == 1
    for path in ("/", "/api/status", "/app.js", "/sessions/codex/abc"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["x-content-type-options"] == "nosniff"
        assert "script-src 'self'" in response.headers["content-security-policy"]
    assert service.refreshes == 1


@pytest.mark.parametrize("host", ["evil.example:8765", "127.0.0.1.evil.example", "testserver",
                                 "127.0.0.1@evil.example", "localhost/", "localhost:bad"])
def test_foreign_or_malformed_hosts_are_rejected(web, host):
    client, service, _ = web
    assert client.get("/api/status", headers={"Host": host}).status_code == 403
    assert client.post("/api/refresh", headers={"Host": host}, json={}).status_code == 403
    assert service.refreshes == 1


@pytest.mark.parametrize("host", ["127.0.0.1:8765", "localhost:8765", "[::1]:8765"])
def test_loopback_hosts_are_accepted(web, host):
    client, _, _ = web
    assert client.get("/api/status", headers={"Host": host}).status_code == 200


@pytest.mark.parametrize("origin", ["https://evil.example", "null", "http://127.0.0.1:8766",
                                   "http://localhost:8765", "https://127.0.0.1:8765"])
def test_origin_must_match_scheme_host_and_port(web, origin):
    client, service, _ = web
    assert client.get("/api/status", headers={"Origin": origin}).status_code == 403
    assert client.post("/api/refresh", headers={"Origin": origin}, json={}).status_code == 403
    assert service.refreshes == 1


def test_same_origin_refresh_and_command_line_refresh(web):
    client, service, _ = web
    assert client.post("/api/refresh", headers={"Origin": "http://127.0.0.1:8765"},
                       json={}).status_code == 202
    assert client.post("/api/refresh", json={}).status_code == 202
    assert service.refreshes == 3


def test_cross_site_fetch_and_forms_cannot_refresh(web):
    client, service, _ = web
    assert client.post("/api/refresh", headers={"Sec-Fetch-Site": "cross-site"},
                       json={}).status_code == 403
    assert client.post("/api/refresh", data={"refresh": "1"}).status_code == 415
    assert client.post("/api/refresh", content="{}",
                       headers={"Content-Type": "text/plain"}).status_code == 415
    assert service.refreshes == 1


def test_refresh_has_no_get_route(web):
    client, service, _ = web
    assert client.get("/api/refresh").status_code == 404
    assert service.refreshes == 1


def test_static_paths_cannot_escape_package_root(web, tmp_path):
    client, _, static = web
    secret = tmp_path / "secret.txt"
    secret.write_text("private source data")
    (static / "escape.txt").symlink_to(secret)
    for path in ("/%2e%2e/secret.txt", "/escape.txt", "/%2Ehidden", "/missing.js",
                 "/api/unknown", "/%5c..%5csecret.txt"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert "private source data" not in response.text


def test_missing_static_bundle_has_actionable_error(tmp_path):
    service = FakeService()
    with TestClient(create_app(service, static_dir=tmp_path / "missing", initial_refresh=False),
                    base_url="http://localhost") as client:
        response = client.get("/")
        assert response.status_code == 503
        assert "npm run build" in response.json()["error"]
        assert client.get("/api/status").status_code == 200
    assert service.refreshes == 0


def test_query_errors_and_session_identity(web):
    client, service, _ = web
    assert client.get("/api/analytics").json()["summary"]["calls"] == 3
    assert client.get("/api/analytics?start=2026-10-01&end=2026-10-05").status_code == 400
    assert client.get("/api/sessions?offset=-1").status_code == 400
    assert client.get("/api/sessions?limit=201").status_code == 400
    assert client.get("/api/sessions?offset=3&limit=10").json()["offset"] == 3
    assert client.get("/api/sessions/codex/present").json()["session"]["harness"] == "codex"
    assert client.get("/api/sessions/claude/missing").status_code == 404
    assert service.refreshes == 1


def test_serve_binds_loopback_only(monkeypatch):
    from harnesscope import server
    calls = []
    sentinel = object()
    monkeypatch.setattr(server, "create_app", lambda: sentinel)
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: calls.append((app, kwargs)))
    server.serve(9988)
    assert calls == [(sentinel, {"host": "127.0.0.1", "port": 9988, "log_level": "warning"})]
