"""自描述与自检：`--schema` 输出机器可读契约，`--doctor` 输出环境诊断。

目标是把「怎么用、能输出什么、为什么没数据/没真图」直接告诉使用者（人也好、
Agent 也好），不用去读源码或 README。`--schema` 从 argparse 定义自动生成选项清单，
避免文档与实现漂移；JSON 字段契约由测试与真实 `--json` 输出对账。
"""

import argparse
import glob
import os
import platform
import shutil
import sys

from . import __version__, config, pricing
from .render import imgcharts

SCHEMA_VERSION = 1

# --help 的补充说明（raw 格式，不折叠换行）
EPILOG = """\
帮助入口:
  harnesscope --help        人读帮助（/?, -?, help 等价）
  harnesscope --schema      机器可读自描述（选项、字段、语义、退出码的 JSON）
  harnesscope --doctor      环境自检（数据源、定价表、真图能力、终端档位）
  harnesscope --web         本机四源用量工作台（默认 http://127.0.0.1:8765）
  harnesscope start         启动用量镜（普通后台或已安装的用户服务）
  harnesscope status        查看运行状态（支持 --json）

示例:
  harnesscope                                      今天各会话明细（含子代理，每会话一行）
  harnesscope --by-model                           按模型聚合
  harnesscope --by-day --since 20260904            按天聚合（紧凑时间 = 2026-09-04）
  harnesscope --by-day --by-model --metric total   天×模型
  harnesscope --family --parent 01a083b7           家族树：主线程 + 各子代理
  harnesscope --chart bar --by-day                 每天成本柱状图（终端下优先出真图）
  harnesscope --chart bar --by-day --ascii         同上，但强制字符画
  harnesscope --json --since 20260910              机器可读：每会话一行 JSON
  harnesscope --schema                             机器可读自描述（本文档的 JSON 版）
  harnesscope --doctor                             环境自检：数据源、定价、真图能力
  harnesscope --web --port 8765                    Codex / Claude / OMP / DSH 用量工作台
  harnesscope --analytics --query 'harness=codex&metric=tokens'  共享分析 JSON
  harnesscope start --port 8765                   后台启动并保存端口
  harnesscope stop                               停止本工具的进程或用户服务
  harnesscope restart                            重启（端口沿用保存的配置）
  harnesscope service install --port 8765         安装用户服务并 enable 登录自启
  harnesscope service remove                      停止并移除用户服务，回到普通模式

语义约定:
  聚合 --by-day/--by-model  决定行粒度，可组合成「天×模型」
  结构 --family/--raw       家族树 / 文件粒度实体（不合并分页）
  过滤 --since/--until/--type/--parent/--session/--model/--archived
                            只缩小范围，不改变行粒度
  输出 --json/--chart       三选一；默认是表格。--json 优先于 --chart
  默认窗口                  今天 00:00:00 ~ 23:59:59（本地时区）

输出与退出码:
  表格        人读，非 TTY 时给足宽度避免截断
  --json      每行一条会话记录（JSON Lines），字段见 `--schema`
  --chart     终端 + 装了 [image] 时出真图，其余情况字符画
  退出码      0 成功；1 用法/运行时错误；2 参数解析错误；3 status 未运行；141 管道下游提前关闭

数据源与环境变量:
  会话      ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl   HARNESCOPE_SESSIONS_DIR
  归档      ~/.codex/archived_sessions                     HARNESCOPE_ARCHIVE_DIR
  Web Codex CODEX_HOME（默认 ~/.codex），含 sessions 与 archived_sessions
  Web Claude CLAUDE_CONFIG_DIR（默认 ~/.claude）下的 projects
  Web OMP   OMP_SESSIONS_DIR；否则 PI_CODING_AGENT_DIR/sessions（默认 ~/.omp/agent/sessions）
  Web DSH   DSH_HOME（默认 ~/.dsh）下的 sessions
  定价      内置表 → 用户缓存 → 自定义文件，后者优先       HARNESCOPE_PRICING_FILE
            刷新：harnesscope --update-pricing（可选 --pricing-source litellm）
  图表档位  HARNESCOPE_IMAGE_MODE=auto|tgp|sixel|halfcell|ascii（默认 auto 自动探测）

Web 与共享分析: 查询参数见 docs/workbench-api.md；默认全部可用事件，时间窗 [start,end)。
Web 仅监听 127.0.0.1；首次后台扫描，之后点击刷新显式重扫；GET 只读取本机索引。
Linux 运行管理: start / stop / restart / status；已安装 harnesscope.service 时管理 systemd --user。
service install 仅安装并 enable，启动请用 start；service remove 停止服务并切回普通模式。
配置: $XDG_CONFIG_HOME/harnesscope/config.json（默认 ~/.config）；端口也可用 HARNESCOPE_PORT。
日志/PID: $XDG_STATE_HOME/harnesscope（默认 ~/.local/state）；--web 保留前台运行方式。
联网说明: 只有 --update-pricing 访问外部网络（拉公开定价表）；Web 在本机提供服务。
"""

_CONVENTIONS = {
    "aggregation": {"flags": ["--by-day", "--by-model"],
                    "note": "决定行粒度，可组合成「天×模型」"},
    "structure": {"flags": ["--family", "--raw"],
                  "note": "--family 主线程+子代理成树带小计；--raw 降到文件粒度（不合并分页）"},
    "filters": {"flags": ["--since", "--until", "--type", "--parent", "--session",
                          "--model", "--archived"],
                "note": "只缩小范围，不改变行粒度；--type 可取值见 enums.type"},
    "default_window": "今天 00:00:00 ~ 23:59:59（本地时区）",
    "metering": {"note": "token 用量按 token_count 的 total_token_usage 累计值增量计，"
                         "按当时 turn_context 的模型归因；首帧若整块是继承的父线程历史"
                         "（last 为 0）则不计；重复事件（累计值不变）不重计；累计值回落"
                         "（上下文压缩重置）或缺累计值时回退 last_token_usage",
                 "diagnostics": "见 --json 的 metering 字段（resets/fallbacks/delta_sum）"},
    "tiers": {"note": "thread_settings_applied 的 service_tier 决定档位（default/priority/fast，"
                      "从未出现过则 unknown）；--json 的 tiers 给出按模型×档位的用量，"
                      "便于核对倍率定价",
              "source": "thread_settings_applied.payload.thread_settings.service_tier"},
    "conflicts": ["--chart 不能与 --family 组合",
                  "--chart pie 不能与 --by-day 组合（饼图只按模型）",
                  "--json 优先于 --chart"],
}

_EXIT_CODES = {"0": "成功", "1": "用法或运行时错误（含参数冲突、时间格式非法）",
               "2": "参数解析错误（argparse）", "3": "运行管理 status 未运行",
               "141": "输出管道下游提前关闭（SIGPIPE）"}

_JSON_FIELDS = {
    "session_id": {"type": "string", "meaning": "会话 ID（子代理取文件名第二个 UUID）"},
    "date": {"type": "string", "meaning": "活动起点日期 YYYY-MM-DD（本地时区）"},
    "time": {"type": "string", "meaning": "活动起点时刻 HH:MM"},
    "type": {"type": "string", "meaning": "user|subagent|guardian|voice|handoff|agent"},
    "agent": {"type": "string|null", "meaning": "子代理昵称(角色)"},
    "parent": {"type": "string|null", "meaning": "父线程 ID"},
    "cwd": {"type": "string|null", "meaning": "会话工作目录"},
    "first_ts": {"type": "string|null", "meaning": "窗口内首个事件时间（ISO，本地）"},
    "last_ts": {"type": "string|null", "meaning": "窗口内最后事件时间（ISO，本地）"},
    "models": {"type": "object", "meaning": "按模型明细，见 model_fields"},
    "input_net": {"type": "integer", "unit": "tokens", "meaning": "净输入 = 毛输入 − 缓存读"},
    "cache_read": {"type": "integer", "unit": "tokens", "meaning": "缓存读"},
    "cache_hit_rate": {"type": "number|null", "meaning": "缓存命中率 = 缓存读 / 毛输入，0~1；"
                                                       "无输入时为 null"},
    "cost_per_million_tokens": {"type": "number|null", "unit": "USD/1M tokens",
                                "meaning": "每百万 tokens 开销 = 成本 ÷ 总 tokens × 1e6；"
                                           "无 tokens 时为 null"},
    "output": {"type": "integer", "unit": "tokens", "meaning": "输出"},
    "total_tokens": {"type": "integer", "unit": "tokens", "meaning": "毛输入 + 输出 = 净输入 + 缓存读 + 输出"},
    "tps": {"type": "number|null", "unit": "tokens/s", "meaning": "端到端 TPS = 完整轮次输出 ÷ 秒数，含工具和等待；仅统计完整单模型轮次，缺计时为 null；聚合按合计输出 ÷ 合计秒数"},
    "calls": {"type": "integer", "meaning": "API 调用次数（token_count 轮次）"},
    "cost_usd_known": {"type": "number", "unit": "USD", "meaning": "按定价折算的成本（无定价按 0）"},
    "pricing_full": {"type": "boolean", "meaning": "是否所有模型都有定价"},
    "last_cumulative_total": {"type": "array|null", "meaning": "[毛输入, 缓存读, 输出] 的文件末累计值（仅参考）"},
    "metering": {"type": "object", "meaning": "{resets, fallbacks, delta_sum}：累计值回落"
                                              "（压缩重置）次数、缺累计回退次数、旧口径"
                                              "（逐轮 last_token_usage 累加）对照值"},
    "tiers": {"type": "object", "meaning": "按模型 × 档位（default|priority|fast|unknown）的用量，"
                                           "槽位同 model_fields；各档求和等于该模型总量"},
}

_MODEL_FIELDS = {
    "input_gross": {"type": "integer", "unit": "tokens", "meaning": "毛输入（含缓存读）"},
    "cached": {"type": "integer", "unit": "tokens", "meaning": "缓存读"},
    "cache_hit_rate": {"type": "number|null", "meaning": "该模型缓存命中率 = 缓存读 / 毛输入，0~1；"
                                                       "无输入时为 null"},
    "cost_per_million_tokens": {"type": "number|null", "unit": "USD/1M tokens",
                                "meaning": "该模型每百万 tokens 开销（按总 tokens 折算）；"
                                           "无 tokens 时为 null"},
    "output": {"type": "integer", "unit": "tokens", "meaning": "输出"},
    "reasoning": {"type": "integer", "unit": "tokens", "meaning": "推理输出"},
    "tps": {"type": "number|null", "unit": "tokens/s", "meaning": "端到端 TPS = 完整轮次输出 ÷ 秒数，含工具和等待；仅统计完整单模型轮次，缺计时为 null；聚合按合计输出 ÷ 合计秒数"},
    "calls": {"type": "integer", "meaning": "该模型参与调用的轮次"},
}

_METRICS = {
    "cost": {"axis": "USD", "meaning": "按定价折算成本（无定价的模型按 0 计）"},
    "input": {"axis": "tokens", "meaning": "净输入 = 毛输入 − 缓存读"},
    "cache": {"axis": "tokens", "meaning": "缓存读"},
    "hit": {"axis": "ratio", "meaning": "缓存命中率 = 缓存读 / 毛输入（毛输入含缓存读），0~1；"
                                       "聚合按 Σ缓存读 / Σ毛输入 加权，不是平均百分比"},
    "output": {"axis": "tokens", "meaning": "输出"},
    "total": {"axis": "tokens", "meaning": "总 tokens = 净输入 + 缓存读 + 输出"},
    "per_mtok": {"axis": "USD/1M tokens", "meaning": "每百万 tokens 开销 = 成本 ÷ 总 tokens × 1e6；"
                                                    "聚合按 Σ成本 ÷ Σ总 tokens 加权，不是平均各行单位价；"
                                                    "与 hit 一样不能与 --chart pie 组合"},
}

_TABLE_COLUMNS = ["净输入", "缓存读", "命中率", "输出", "总 tokens", "调用",
                  "单次成本", "每百万 tokens", "TPS", "成本"]

_DATA_SOURCES = {
    "sessions_dir": {"env": "HARNESCOPE_SESSIONS_DIR", "default": "~/.codex/sessions",
                     "pattern": "YYYY/MM/DD/rollout-*.jsonl"},
    "archive_dir": {"env": "HARNESCOPE_ARCHIVE_DIR", "default": "~/.codex/archived_sessions"},
    "pricing_file": {"env": "HARNESCOPE_PRICING_FILE",
                     "precedence": ["HARNESCOPE_PRICING_FILE（自定义，cc-switch 兼容格式）",
                                    "用户缓存 ~/.cache/harnesscope/pricing.json（HARNESCOPE_CACHE_DIR 可覆盖）",
                                    "内置表 src/harnesscope/data/pricing.json（随包发行，离线可用）"],
                     "refresh": "harnesscope --update-pricing [--pricing-source models.dev|litellm]"},
}

_EXAMPLES = [
    {"command": "harnesscope start --port 8765", "description": "后台启动并保存端口"},
    {"command": "harnesscope status --json", "description": "结构化运行状态，未运行退出 3"},
    {"command": "harnesscope service install --port 8765", "description": "安装用户服务并启用登录自启"},
    {"command": "harnesscope --web", "description": "启动本机四源用量工作台"},
    {"command": "harnesscope --analytics --query 'harness=codex&metric=tokens'",
     "description": "四源共享分析 JSON，可按 API 参数筛选和分组"},
    {"command": "harnesscope --by-model", "description": "按模型聚合（每模型一行，含会话数）"},
    {"command": "harnesscope --by-day --since 20260904", "description": "按天聚合，紧凑时间写法"},
    {"command": "harnesscope --by-day --by-model --metric total", "description": "天×模型"},
    {"command": "harnesscope --family --parent 01a083b7", "description": "家族树：主线程+子代理"},
    {"command": "harnesscope --chart bar --by-day", "description": "每天成本柱状图（终端下优先真图）"},
    {"command": "harnesscope --chart bar --by-day --ascii", "description": "强制字符画图表"},
    {"command": "harnesscope --json --since 20260910", "description": "每会话一行 JSON（JSON Lines）"},
    {"command": "harnesscope --doctor", "description": "环境自检：数据源、定价、真图能力"},
]


def _jsonable(value):
    """把 argparse 默认值收敛成可 JSON 序列化的形式。"""
    if value in (None, True, False) or isinstance(value, (int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return str(value)


def _options(parser: argparse.ArgumentParser) -> list[dict]:
    """从 argparse 定义生成选项清单（保证文档不落后于实现）。"""
    out = []
    for action in parser._actions:
        if not action.option_strings:
            continue
        out.append({
            "flags": list(action.option_strings),
            "dest": action.dest,
            "takes_value": action.nargs != 0,
            "choices": list(action.choices) if action.choices else None,
            "default": _jsonable(action.default),
            "help": (action.help or "").splitlines()[0],
        })
    return out


def schema(parser: argparse.ArgumentParser) -> dict:
    """机器可读自描述：命令契约、语义、输出字段、环境变量、退出码。"""
    return {
        "schema_version": SCHEMA_VERSION,
        "name": "harnesscope",
        "version": __version__,
        "summary": "本机 Codex / Claude / OMP / DSH 用量工作台；兼容原 Codex 终端统计",
        "usage": parser.format_usage().removeprefix("usage: ").strip(),
        "options": _options(parser),
        "conventions": _CONVENTIONS,
        "enums": {"type": ["user", "subagent", "guardian", "voice", "handoff", "agent"],
                  "chart": ["pie", "bar", "area", "line"],
                  "metric": ["cost", "input", "cache", "output", "total"]},
        "metrics": _METRICS,
        "tables": {"columns": _TABLE_COLUMNS,
                   "note": "末 7 列固定；合计行与数据行同列右对齐"},
        "json_output": {"format": "jsonl（每行一条会话记录）",
                        "fields": _JSON_FIELDS, "model_fields": _MODEL_FIELDS},
        "chart_rendering": {
            "flags": ["--chart", "--metric", "--ascii"],
            "tiers": ["终端支持图形协议（kitty/Sixel）→ 直接显示 PNG 真图",
                      "终端不支持图形协议 → 彩色半块字符",
                      "未装 [image] extras / 输出被管道重定向 / --ascii → plotext 字符画"],
            "env": {"HARNESCOPE_IMAGE_MODE": "auto|tgp|sixel|halfcell|ascii",
                    "note": "覆盖自动探测的显示档位；ascii 等同 --ascii；"
                            "遇到把真图渲染坏的终端可降级到 halfcell"},
            "ascii_labels": "字符画档位下标题与图例自动转写为 ASCII（plotext 不支持宽字符会错位）",
            "install": "源码 checkout 运行 ./install.sh --image；PyPI 发布后可用 "
                       "uv tool install \"harnesscope[image]\"；真图协议需 Python ≥3.12",
        },
        "data_sources": _DATA_SOURCES,
        "runtime_management": {
            "platform": "linux",
            "commands": ["start [--port PORT] [--json]", "stop [--json]",
                         "restart [--port PORT] [--json]", "status [--json]",
                         "service install [--port PORT] [--json]", "service remove [--json]"],
            "modes": "已安装本工具用户服务配置时使用 systemd --user；其余使用后台进程",
            "foreground": "harnesscope --web [--port PORT]",
            "config": "$XDG_CONFIG_HOME/harnesscope/config.json (default ~/.config)",
            "state": "$XDG_STATE_HOME/harnesscope (default ~/.local/state)",
            "port": "显式 --port > HARNESCOPE_PORT > 保存的端口 > 8765",
            "unit": "harnesscope.service；enable 登录自启；install 不立即启动",
            "service_environment": "安装时保存 HARNESCOPE_*、XDG 与原生四源路径覆盖；重新 install 更新",
            "process_identity": "boot id、PID 启动时刻、随机实例标识；flock 串行管理，pidfd 安全停止",
            "status_exit": "运行 0；未运行 3；运行管理错误 1",
        },
        "workbench": {
            "command": "harnesscope --web [--port 8765]",
            "listen": "127.0.0.1",
            "sources": {
                "codex": {"env": "CODEX_HOME", "default": "~/.codex",
                          "directories": ["sessions", "archived_sessions"]},
                "claude": {"env": "CLAUDE_CONFIG_DIR", "default": "~/.claude",
                           "directories": ["projects"]},
                "omp": {"env": "OMP_SESSIONS_DIR", "default": "~/.omp/agent/sessions",
                        "fallback_env": "PI_CODING_AGENT_DIR (append /sessions)"},
                "dsh": {"env": "DSH_HOME", "default": "~/.dsh",
                        "directories": ["sessions"]},
            },
            "api": ["GET /api/status", "GET /api/analytics", "GET /api/sessions",
                    "GET /api/sessions/{harness}/{sid}", "GET /api/turns",
                    "GET /api/turns/detail?harness=...&session_id=...&turn_id=...",
                    "POST /api/refresh"],
            "turn_detail_identity": {
                "parameters": ["harness", "session_id", "turn_id"],
                "encoding": "URL 查询参数编码；每个标识单个非空值，允许包含 /",
                "missing": "404；缺失、空值或重复标识 400",
            },
            "query_contract": "docs/workbench-api.md",
            "analytics_command": "harnesscope --analytics [--query URL_QUERY]",
            "analytics_output": "one JSON object; same query and metrics as GET /api/analytics",
            "default_window": "全部已索引事件；显式时间窗口 [start,end)，ISO 时间须含 offset",
            "refresh": "启动后台扫描；GET 无扫描副作用；POST application/json 显式刷新",
            "security": "本机 Host、严格同源 Origin、禁止跨站请求；本机进程可访问，无登录凭据",
        },
        "exit_codes": _EXIT_CODES,
        "examples": _EXAMPLES,
    }


def _count_rollouts(directory: str) -> tuple[int, str | None]:
    """统计目录下的 rollout 文件数与最近修改时间。"""
    files = glob.glob(os.path.join(directory, "**", "rollout-*.jsonl"), recursive=True)
    newest = max((os.path.getmtime(f) for f in files), default=None)
    stamp = None
    if newest:
        from datetime import datetime
        stamp = datetime.fromtimestamp(newest).strftime("%Y-%m-%d %H:%M")
    return len(files), stamp


def doctor() -> dict:
    """环境自检：数据源、定价表、真图能力、终端档位与建议。"""
    sessions = config.sessions_dir()
    archive = config.archive_dir()
    price_file = config.pricing_file()
    n_sessions, newest = _count_rollouts(sessions) if os.path.isdir(sessions) else (0, None)
    n_archive, _ = _count_rollouts(archive) if os.path.isdir(archive) else (0, None)
    table = pricing.load_pricing()          # 无参：走完整优先级（自定义 > 缓存 > 内置），不是"只读指定文件"
    price_src = pricing.source_info()
    try:
        price_cov = pricing.cache_read_coverage(table)   # 表级缺口：缓存读价缺失比例
    except Exception:
        price_cov = {}
    render = imgcharts.describe()
    from .adapters import get_adapters
    workbench_sources = [
        {"harness": adapter.harness, "path": str(adapter.root),
         "exists": adapter.root.is_dir()}
        for adapter in get_adapters()
    ]

    hints, notes = [], []
    if not os.path.isdir(sessions):
        hints.append(f"会话目录不存在: {sessions}（确认 Codex 在本机跑过，或用 HARNESCOPE_SESSIONS_DIR 指定）")
    elif n_sessions == 0:
        hints.append(f"会话目录里没有 rollout-*.jsonl: {sessions}")
    price_src = pricing.source_info()
    if not table:
        hints.append(f"定价不可用: 内置表与自定义文件都读不到（{price_file}）；"
                     "token 照常统计、成本按 $0 计并标 *，可用 --update-pricing 拉取公开定价")
    elif os.environ.get("HARNESCOPE_PRICING_FILE") and \
            "env-file" not in (price_src.get("source") or ""):
        notes.append(f"自定义定价文件不可用，已回退 {price_src.get('source')}: "
                     f"{os.environ['HARNESCOPE_PRICING_FILE']}")
    if not render["available"]:
        hints.append("真图图表不可用：未装 matplotlib/textual-image（"
                     "uv tool install \"harnesscope[image]\"，需 Python ≥3.12）")
    elif not sys.stdout.isatty():
        notes.append("当前输出不是终端：图表会走字符画；看真图请在终端里直接运行")
    elif render["display"] == "字符回退":
        notes.append("当前终端不支持图形协议：图表会以彩色半块显示")
    if render["available"] and render["cjk_font"] is None:
        hints.append("系统缺中文字体：图表里的中文可能显示为方框（可装 Noto Sans CJK）")

    return {
        "name": "harnesscope",
        "version": __version__,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "executable": shutil.which("harnesscope") or sys.argv[0],
        "data": {
            "workbench_sources": workbench_sources,
            "sessions_dir": {"path": sessions, "exists": os.path.isdir(sessions),
                             "rollout_files": n_sessions, "newest_mtime": newest},
            "archive_dir": {"path": archive, "exists": os.path.isdir(archive),
                            "rollout_files": n_archive},
            "pricing_file": {"path": price_file, "exists": os.path.isfile(price_file),
                             "models": price_src.get("models", len(table)),
                             "source": price_src.get("source"),
                             "loaded_from": price_src.get("path"),
                             "layers": price_src.get("layers"),
                             "cache_read_missing": price_cov.get("cache_read_missing"),
                             "cache_read_missing_pct": price_cov.get("cache_read_missing_pct"),
                             "updated": price_src.get("updated")},
        },
        "render": {**render, "stdout_is_tty": sys.stdout.isatty(),
                   "tier": _tier(render)},
        "hints": hints,
        "notes": notes,
        "ok": not hints,
    }


def _tier(render: dict) -> str:
    if render.get("mode") == "ascii":
        return "字符画（HARNESCOPE_IMAGE_MODE=ascii）"
    if not render["available"]:
        return "字符画（未装 [image] extras）"
    if not sys.stdout.isatty():
        return "字符画（输出非终端）"
    return render["display"] or "未知"


def format_doctor(d: dict) -> str:
    """人读版自检报告。"""
    data, render = d["data"], d["render"]
    price = data["pricing_file"]
    # source 是复合值（内置表为基底，用户缓存/自定义文件逐层覆盖），逐层转中文再拼回
    _layer_label = {"builtin": "内置表", "user-cache": "本地缓存", "env-file": "自定义文件"}
    src_label = "+".join(_layer_label.get(s, s)
                         for s in (price.get("source") or "builtin").split("+"))
    mode = render.get("mode", "auto")
    detail = (f"（matplotlib {render['matplotlib']} + textual-image {render['textual_image']}，"
              f"光栅 {render['raster_px'][0]}×{render['raster_px'][1]}"
              + (f"，档位 {mode}，自动探测为 {render['detected']}" if mode != "auto"
                 else f"，档位 auto（探测为 {render['detected']}）") + "）"
              if render["available"] and render["raster_px"] else "")
    lines = [f"harnesscope {d['version']}  |  Python {d['python']}  |  {d['platform']}",
             "",
             f"会话数据   {data['sessions_dir']['path']}"
             f"  {'存在' if data['sessions_dir']['exists'] else '不存在'}"
             f"，{data['sessions_dir']['rollout_files']} 个 rollout 文件"
             + (f"（最近 {data['sessions_dir']['newest_mtime']}）" if data['sessions_dir']['newest_mtime'] else ""),
             f"归档数据   {data['archive_dir']['path']}"
             f"  {'存在' if data['archive_dir']['exists'] else '不存在'}"
             f"，{data['archive_dir']['rollout_files']} 个 rollout 文件",
             f"定价       {src_label} {price.get('loaded_from') or price['path'] or '(未读取)'}，"
             f"{price['models']} 个模型"
             + (f"（数据 {price['updated'][:10]}）" if price.get("updated") else "")
             + (f"，其中 {price['cache_read_missing_pct']}% 缺缓存读价（按 input 价回退）"
                if price.get("cache_read_missing") else ""),
             f"图表渲染   {render['tier']}{detail}",
             f"中文字体   {render['cjk_font'] or '未找到'}"]
    if data.get("workbench_sources"):
        lines += ["", "Web 数据源（路径发现；格式与扫描状态请查看工作台）:"]
        lines += [f"  {source['harness']}  {source['path']}  "
                  f"{'存在' if source['exists'] else '不存在'}"
                  for source in data["workbench_sources"]]
    if d["hints"]:
        lines += ["", "需要注意:"] + [f"  - {h}" for h in d["hints"]]
    else:
        lines += ["", "结论: 一切正常"]
    if d.get("notes"):
        lines += ["", "说明:"] + [f"  - {n}" for n in d["notes"]]
    return "\n".join(lines)
