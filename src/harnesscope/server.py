"""Loopback-only web workbench; HTTP reads indexed usage, never source paths.

Host validation blocks DNS rebinding. Same-origin requests and JSON-only refresh
block browser cross-site writes without a persistent credential. Any local
process/account can query the running server; it assumes a personal workstation.
"""

from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route

DEFAULT_PORT = 8765
STATIC_DIR = Path(__file__).parent / "web_static"
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)


class LocalOnlyMiddleware:
    """Reject foreign Host/Origin before any route or scan action runs."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        hosts = request.headers.getlist("host")
        origins = request.headers.getlist("origin")
        try:
            host = hosts[0] if len(hosts) == 1 else ""
            parsed = urlsplit("http://" + host)
            valid_host = (
                bool(host) and parsed.hostname in _LOCAL_HOSTS
                and parsed.username is None and parsed.password is None
                and not parsed.path and not parsed.query and not parsed.fragment
                and (parsed.port is None or 1 <= parsed.port <= 65535)
                and host == host.strip()
            )
        except ValueError:
            valid_host = False
        origin = origins[0] if len(origins) == 1 else None
        same_origin = not origins or (
            len(origins) == 1 and origin == f"{scope.get('scheme', 'http')}://{host}"
        )
        site = request.headers.get("sec-fetch-site", "")
        if not valid_host or not same_origin or site == "cross-site":
            response = JSONResponse({"error": "仅允许本机同源访问"}, status_code=403)
            await response(scope, receive, send)
            return

        async def secure_send(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend([
                    (b"content-security-policy", _CSP.encode()),
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"cache-control", b"no-store"),
                ])
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, secure_send)


def create_app(service=None, *, static_dir: Path | None = None,
               initial_refresh: bool = True, instance_id: str | None = None) -> Starlette:
    """Build an app; injected services/static directories support isolated tests."""
    if service is None:
        from .service import UsageService
        service = UsageService()
    root = (static_dir or STATIC_DIR).resolve()

    @asynccontextmanager
    async def lifespan(app):
        if initial_refresh:
            await run_in_threadpool(service.refresh, background=True)
        try:
            yield
        finally:
            await run_in_threadpool(service.close)

    async def status(request: Request) -> Response:
        import os
        result = await run_in_threadpool(service.status)
        return JSONResponse({**result, "server_pid": os.getpid(), "instance_id": instance_id})

    async def refresh(request: Request) -> Response:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip()
        if content_type.lower() != "application/json":
            return JSONResponse({"error": "刷新请求需要 application/json"}, status_code=415)
        # The endpoint has no configuration or paths to deserialize.
        result = await run_in_threadpool(service.refresh, background=True)
        return JSONResponse(result, status_code=202)

    async def accounts(request: Request) -> Response:
        return JSONResponse(await run_in_threadpool(service.accounts))

    def query_request(request: Request):
        from .query import QueryRequest
        params = {key: request.query_params.getlist(key) for key in request.query_params}
        return QueryRequest.from_params(params)

    def pagination(request: Request) -> tuple[int, int]:
        offset = int(request.query_params.get("offset", "0"))
        limit = int(request.query_params.get("limit", "50"))
        if offset < 0 or not 1 <= limit <= 200:
            raise ValueError("offset 须非负，limit 须在 1 到 200 之间")
        return offset, limit

    def option(request: Request, name: str, default: str) -> str:
        values = request.query_params.getlist(name)
        if len(values) > 1:
            raise ValueError(f'{name} 需要单个值')
        return values[0] if values else default

    async def usage(request: Request) -> Response:
        try:
            query = query_request(request)
            offset, limit = pagination(request)
            result = await run_in_threadpool(service.usage, query, offset=offset, limit=limit,
                group=option(request, 'group', 'request'), sort=option(request, 'sort', 'time'),
                order=option(request, 'order', 'desc'), turn_ids=request.query_params.getlist('turn_id'))
            return JSONResponse(result)
        except ValueError as exc:
            return JSONResponse({'error': str(exc)}, status_code=400)

    async def analytics(request: Request) -> Response:
        try:
            query = query_request(request)
            result = await run_in_threadpool(service.analytics, query)
            return JSONResponse(result)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    async def sessions(request: Request) -> Response:
        try:
            query = query_request(request)
            offset, limit = pagination(request)
            result = await run_in_threadpool(service.sessions, query, offset=offset, limit=limit)
            return JSONResponse(result)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    async def detail(request: Request) -> Response:
        try:
            query = query_request(request)
            result = await run_in_threadpool(
                service.session_detail, request.path_params["harness"],
                request.path_params["sid"], request=query,
            )
            if result is None:
                return JSONResponse({"error": "会话不存在"}, status_code=404)
            return JSONResponse(result)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    async def turns(request: Request) -> Response:
        try:
            query = query_request(request)
            offset, limit = pagination(request)
            include_rows = option(request, 'include_rows', 'true')
            if include_rows not in ('true', 'false'):
                raise ValueError('include_rows 需要 true 或 false')
            result = await run_in_threadpool(service.turns, query, offset=offset, limit=limit,
                sort=option(request, 'sort', 'start'), order=option(request, 'order', 'desc'),
                include_rows=include_rows == 'true')
            return JSONResponse(result)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    async def turn_detail(request: Request) -> Response:
        try:
            identifiers = []
            for name in ("harness", "session_id", "turn_id"):
                values = request.query_params.getlist(name)
                if len(values) != 1 or not values[0]:
                    raise ValueError(f"{name} 需要单个非空标识")
                identifiers.append(values[0])
            query = query_request(request)
            result = await run_in_threadpool(service.turn_detail, *identifiers, request=query)
            if result is None:
                return JSONResponse({"error": "轮次不存在"}, status_code=404)
            return JSONResponse(result)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    async def static(request: Request) -> Response:
        path = request.path_params.get("path", "")
        if ("\\" in path or "\x00" in path or ".." in path.split("/")
                or any(part.startswith(".") for part in path.split("/") if part)):
            return JSONResponse({"error": "无效资源路径"}, status_code=404)
        target = (root / path).resolve()
        if not target.is_relative_to(root):
            return JSONResponse({"error": "无效资源路径"}, status_code=404)
        if path.startswith("api/") or path == "api":
            return JSONResponse({"error": "接口不存在"}, status_code=404)
        if target.is_file():
            return FileResponse(target)
        if path and Path(path).suffix:
            return JSONResponse({"error": "资源不存在"}, status_code=404)
        index = (root / "index.html").resolve()
        if not index.is_relative_to(root):
            return JSONResponse({"error": "无效资源路径"}, status_code=404)
        if not index.is_file():
            return JSONResponse({"error": "Web 静态资源缺失；源码安装请执行 cd web && npm ci && npm run build"},
                                status_code=503)
        return FileResponse(index)

    app = Starlette(routes=[
        Route("/api/status", status, methods=["GET"]),
        Route("/api/accounts", accounts, methods=["GET"]),
        Route("/api/refresh", refresh, methods=["POST"]),
        Route("/api/analytics", analytics, methods=["GET"]),
        Route("/api/usage", usage, methods=["GET"]),
        Route("/api/sessions", sessions, methods=["GET"]),
        Route("/api/sessions/{harness}/{sid}", detail, methods=["GET"]),
        Route("/api/turns", turns, methods=["GET"]),
        Route("/api/turns/detail", turn_detail, methods=["GET"]),
        Route("/{path:path}", static, methods=["GET"]),
    ], lifespan=lifespan)
    app.add_middleware(LocalOnlyMiddleware)
    app.state.service = service
    return app


def serve(port: int = DEFAULT_PORT, *, socket_fd: int | None = None,
          instance_id: str | None = None) -> None:
    """Run the local workbench; listening on external interfaces is unsupported."""
    import uvicorn
    print(f"本机用量工作台：http://127.0.0.1:{port}（Ctrl+C 停止）", flush=True)
    app = create_app(instance_id=instance_id) if instance_id is not None else create_app()
    if socket_fd is None:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    else:
        uvicorn.run(app, host="127.0.0.1", port=port, fd=socket_fd, log_level="warning")
