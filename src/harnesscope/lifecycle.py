"""Linux workstation process management and an optional current-user systemd unit."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

DEFAULT_PORT = 8765
UNIT = "harnesscope.service"
UNIT_MARKER = "# Managed by Harnesscope; service install/remove\n"
COMMANDS = {"start", "stop", "restart", "status", "service", "_run", "_service-run"}
_NATIVE_ENV = {"HOME", "PATH", "LANG", "TZ", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
               "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OMP_SESSIONS_DIR",
               "PI_CODING_AGENT_DIR", "DSH_HOME"}


class LifecycleError(RuntimeError):
    pass


def config_path() -> Path:
    root = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    return root.expanduser().absolute() / "harnesscope" / "config.json"


def state_dir() -> Path:
    root = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state")))
    return root.expanduser().absolute() / "harnesscope"


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError("expected an object")
        return value
    except (ValueError, OSError) as exc:
        raise LifecycleError(f"无法读取配置 {path}: {exc}") from exc


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".harnesscope-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def configured_port(port: int | None = None, settings: dict | None = None) -> int:
    settings = _load(config_path()) if settings is None else settings
    value = port if port is not None else os.environ.get("HARNESCOPE_PORT", settings.get("port", DEFAULT_PORT))
    try:
        selected = int(value)
    except (TypeError, ValueError) as exc:
        raise LifecycleError("端口须为 1 到 65535 的整数") from exc
    if not 1 <= selected <= 65535:
        raise LifecycleError("端口须在 1 到 65535 之间")
    return selected


@contextmanager
def _locked():
    import fcntl
    root = state_dir()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(root / "lifecycle.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _boot_id() -> str:
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def _process_stamp(pid: int) -> tuple[str, str]:
    # comm may contain spaces/parentheses. Fields after its final ')' begin at state.
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    return fields[19], fields[0]


def _own_process(record: dict) -> bool:
    try:
        pid = int(record["pid"])
        if pid <= 1 or record["boot_id"] != _boot_id():
            return False
        ticks, state = _process_stamp(pid)
        if ticks != record["start_ticks"] or state == "Z":
            return False
        args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        token = record["token"].encode()
        return (args[1:4] == [b"-m", b"harnesscope.cli", b"_run"]
                and b"--instance-token" in args
                and args[args.index(b"--instance-token") + 1] == token)
    except (OSError, KeyError, ValueError, TypeError, IndexError, AttributeError):
        return False


def _background_record() -> dict:
    path = state_dir() / "process.json"
    record = _load(path)
    if record and not _own_process(record):
        path.unlink(missing_ok=True)
        return {}
    return record


def _stop_background() -> None:
    record = _background_record()
    if not record:
        return
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise LifecycleError("本机缺少 pidfd 支持，无法安全停止后台进程")
    try:
        fd = os.pidfd_open(int(record["pid"]))
    except ProcessLookupError:
        (state_dir() / "process.json").unlink(missing_ok=True)
        return
    try:
        if _own_process(record):
            signal.pidfd_send_signal(fd, signal.SIGTERM)
            if not select.select([fd], [], [], 15)[0]:
                raise LifecycleError("后台进程在 15 秒内未停止，请查看本工具日志")
        (state_dir() / "process.json").unlink(missing_ok=True)
    finally:
        os.close(fd)


def _reserve(port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
        sock.listen(128)
        return sock
    except OSError as exc:
        sock.close()
        raise LifecycleError(f"无法监听 127.0.0.1:{port}（端口可能已占用）: {exc}") from exc


def _ready(pid: int, port: int, token: str | None = None) -> bool:
    try:
        opener = build_opener(ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/api/status", timeout=0.4) as response:
            data = json.load(response)
        return data.get("server_pid") == pid and (token is None or data.get("instance_id") == token)
    except (OSError, URLError, ValueError):
        return False


def _start_background(port: int) -> dict:
    sock = _reserve(port)
    token = secrets.token_hex(16)
    log = state_dir() / "harnesscope.log"
    try:
        log_fd = os.open(log, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
        with os.fdopen(log_fd, "ab", buffering=0) as output:
            child = subprocess.Popen(
                [sys.executable, "-m", "harnesscope.cli", "_run", "--port", str(port),
                 "--instance-token", token, "--socket-fd", str(sock.fileno())],
                stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                pass_fds=(sock.fileno(),), start_new_session=True,
            )
    finally:
        sock.close()
    record = {"pid": child.pid, "start_ticks": _process_stamp(child.pid)[0],
              "boot_id": _boot_id(), "token": token, "port": port}
    _write(state_dir() / "process.json", record)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if child.poll() is not None:
            break
        if _ready(child.pid, port, token):
            return record
        time.sleep(0.05)
    _stop_background()
    raise LifecycleError(f"后台启动失败，请查看 {log}")


def _systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True)
    if check and result.returncode:
        reason = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise LifecycleError(f"systemctl --user {' '.join(args)} 失败: {reason}")
    return result


def _service_state() -> dict:
    result = _systemctl("show", UNIT, "--property=LoadState", "--property=ActiveState",
                       "--property=SubState", "--property=MainPID", "--property=FragmentPath",
                       "--property=ExecMainStatus", "--property=UnitFileState", check=False)
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if not values:
        raise LifecycleError(result.stderr.strip() or "无法连接当前用户的 systemd manager")
    return values


def _status(settings: dict) -> dict:
    installed = bool(settings.get("service"))
    port = int(settings.get("port", configured_port(settings=settings)))
    if installed:
        status = _service_state()
        fragment = status.get("FragmentPath")
        expected = Path(settings["service"]["unit_path"])
        if fragment and Path(fragment).resolve() != expected.resolve():
            raise LifecycleError(f"当前服务来自 {fragment}，与本工具安装记录不符")
        pid = int(status.get("MainPID", 0))
        active = status.get("ActiveState") == "active" and pid > 0
        result = {"mode": "service", "running": active, "pid": pid or None,
                  "unit": UNIT, "active_state": status.get("ActiveState"),
                  "exit_status": int(status.get("ExecMainStatus", 0)),
                  "enabled": status.get("UnitFileState") in {"enabled", "enabled-runtime"},
                  "fragment_path": fragment}
    else:
        record = _background_record()
        port = int(record.get("port", port))
        result = {"mode": "background", "running": bool(record), "pid": record.get("pid")}
    return {**result, "port": port, "url": f"http://127.0.0.1:{port}",
            "config": str(config_path()), "log": str(state_dir() / "harnesscope.log")}


def _start_service(port: int) -> None:
    with _reserve(port):
        pass
    _systemctl("start", UNIT)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        state = _service_state()
        pid = int(state.get("MainPID", 0))
        if state.get("ActiveState") == "active" and pid and _ready(pid, port):
            return
        if state.get("ActiveState") == "failed":
            break
        time.sleep(0.1)
    _systemctl("stop", UNIT, check=False)
    raise LifecycleError(f"用户服务启动失败，请查看 {state_dir() / 'harnesscope.log'} 或 journalctl --user -u {UNIT}")


def _stop(settings: dict) -> None:
    if settings.get("service"):
        _systemctl("stop", UNIT)
    else:
        _stop_background()


def _capture_environment() -> dict:
    environment = {}
    for key, value in os.environ.items():
        if key not in _NATIVE_ENV and not key.startswith("HARNESCOPE_"):
            continue
        if key != "PATH" and (key in _NATIVE_ENV - {"LANG", "TZ"}
                              or key.endswith(("_DIR", "_FILE"))):
            value = str(Path(value).expanduser().absolute())
        environment[key] = value
    return environment


def _unit_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$")
    if any(c in escaped for c in "\n\r\0"):
        raise LifecycleError("服务执行路径不能包含换行或 NUL")
    return f'"{escaped}"'


def _install(settings: dict, port: int) -> dict:
    root = config_path().parent.parent
    unit_path = root / "systemd" / "user" / UNIT
    if unit_path.exists() and not unit_path.read_text().startswith(UNIT_MARKER):
        raise LifecycleError(f"已有其他配置占用 {unit_path}，未覆盖")
    current = _service_state().get("FragmentPath")
    if current and Path(current).resolve() != unit_path.resolve():
        raise LifecycleError(f"已有用户服务来自 {current}，未覆盖")
    _stop_background()
    executable = str(Path(sys.executable).absolute())  # Keep the venv path, not its symlink target.
    command = " ".join(_unit_quote(part) for part in
                       [executable, "-m", "harnesscope.cli", "_service-run", "--config", str(config_path())])
    text = (UNIT_MARKER + "[Unit]\nDescription=Harnesscope local usage workbench\n\n"
            "[Service]\nType=exec\n" + f"ExecStart={command}\n"
            "Restart=on-failure\nRestartSec=3\nTimeoutStopSec=20\n\n"
            "[Install]\nWantedBy=default.target\n")
    unit_path.parent.mkdir(parents=True, exist_ok=True)
    unit_path.write_text(text)
    settings.update(port=port, service={"unit_path": str(unit_path), "python": executable,
                                      "environment": _capture_environment()})
    _write(config_path(), settings)
    # Register custom XDG configurations with the already-running manager, then
    # let systemd own enablement in its actual user configuration tree.
    _systemctl("link", "--runtime", str(unit_path))
    _systemctl("daemon-reload")
    _systemctl("enable", str(unit_path))
    return settings


def _remove(settings: dict) -> dict:
    service = settings.get("service")
    if not service:
        return settings
    path = Path(service["unit_path"])
    if not path.is_file() or not path.read_text().startswith(UNIT_MARKER):
        raise LifecycleError(f"服务配置来源无法确认: {path}，未删除")
    current = _service_state().get("FragmentPath")
    if current and Path(current).resolve() != path.resolve():
        raise LifecycleError(f"当前加载服务来自 {current}，未停止或删除")
    _systemctl("stop", UNIT)
    _systemctl("disable", str(path))
    _systemctl("disable", "--runtime", UNIT)
    path.unlink()
    _systemctl("daemon-reload")
    _systemctl("reset-failed", UNIT, check=False)
    settings.pop("service", None)
    _write(config_path(), settings)
    return settings


def _redirect_log() -> None:
    root = state_dir()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(root / "harnesscope.log", os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    try:
        os.dup2(fd, 1)
        os.dup2(fd, 2)
    finally:
        os.close(fd)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harnesscope", description="管理本机用量镜")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("start", "stop", "restart", "status"):
        command = sub.add_parser(name)
        command.add_argument("--json", action="store_true", help="输出结构化状态")
        if name in ("start", "restart"):
            command.add_argument("--port", type=int, help="端口（持久保存，默认 8765）")
    service = sub.add_parser("service", help="安装或移除当前用户 systemd 服务")
    actions = service.add_subparsers(dest="action", required=True)
    install = actions.add_parser("install")
    install.add_argument("--port", type=int)
    install.add_argument("--json", action="store_true")
    remove = actions.add_parser("remove")
    remove.add_argument("--json", action="store_true")
    child = sub.add_parser("_run", help=argparse.SUPPRESS)
    child.add_argument("--port", required=True, type=int)
    child.add_argument("--instance-token", required=True)
    child.add_argument("--socket-fd", required=True, type=int)
    unit = sub.add_parser("_service-run", help=argparse.SUPPRESS)
    unit.add_argument("--config", type=Path, required=True)
    return parser


def run_cli(argv: list[str]) -> int:
    args = _parser().parse_args(argv)
    try:
        if sys.platform != "linux":
            raise LifecycleError("运行管理目前支持 Linux；本机报表与 --web 前台模式仍可使用")
        if args.command in ("_run", "_service-run"):
            from .server import serve
            if args.command == "_run":
                serve(args.port, socket_fd=args.socket_fd, instance_id=args.instance_token)
            else:
                settings = _load(args.config)
                service = settings.get("service")
                if not service:
                    raise LifecycleError("用户服务配置已移除")
                os.environ.update(service["environment"])
                _redirect_log()
                serve(configured_port(port=settings.get("port", DEFAULT_PORT), settings=settings))
            return 0
        with _locked():
            settings = _load(config_path())
            before = _status(settings)
            if args.command == "service":
                if args.action == "install":
                    port = configured_port(args.port, settings)
                    if before["running"] and port != before["port"]:
                        raise LifecycleError("服务正在运行；更换端口请先 stop 或使用 restart --port")
                    settings = _install(settings, port)
                    message = "用户服务已安装并启用登录自启；使用 harnesscope start 启动"
                else:
                    settings = _remove(settings)
                    message = "用户服务已移除，已回到普通后台模式"
            elif args.command == "status":
                message = "正在运行" if before["running"] else "未运行"
            elif args.command == "stop":
                _stop(settings)
                message = "已停止"
            else:
                port = configured_port(args.port, settings)
                if before["running"] and args.command == "start":
                    if before["port"] != port:
                        raise LifecycleError(f"已运行于端口 {before['port']}；更换端口请使用 restart --port")
                    message = "已在运行"
                else:
                    if args.command == "restart":
                        _stop(settings)
                    settings["port"] = port
                    _write(config_path(), settings)
                    if settings.get("service"):
                        _start_service(port)
                    else:
                        _start_background(port)
                    message = "已启动" if args.command == "start" else "已重启"
            result = {**_status(settings), "message": message}
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            label = "用户服务" if result["mode"] == "service" else "后台进程"
            print(f"{message} · {label} · {result['url']}" +
                  (f" · PID {result['pid']}" if result["pid"] else ""))
            print(f"日志：{result['log']}")
        return 3 if args.command == "status" and not result["running"] else 0
    except (LifecycleError, OSError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
