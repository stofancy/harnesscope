#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Harnesscope（用量镜）源码安装

用法：./install.sh [--service | --no-service] [--port PORT] [--image]

  --service     配置当前用户的 systemd 服务，登录自启，并立即启动
  --no-service  移除本工具的用户服务，切回普通后台运行方式
  --port PORT   服务端口，默认 8765（配合 --service）
  --image       安装终端真图图表依赖
  -h, --help    显示帮助

默认安装程序，保留已有运行方式。首次安装默认使用普通后台方式。
需要 uv、Node.js 和 npm。普通查询及运行无需 Node.js。
安装后：harnesscope start | stop | restart | status
启停管理支持 Linux；其他平台使用前台模式。
前台运行：harnesscope --web
EOF
}

mode=keep
port=8765
port_set=false
extra=
while (($#)); do
  case "$1" in
    --service)
      [[ "$mode" != remove ]] || { echo '--service 与 --no-service 不能同时使用' >&2; exit 2; }
      mode=service; shift ;;
    --no-service)
      [[ "$mode" != service ]] || { echo '--service 与 --no-service 不能同时使用' >&2; exit 2; }
      mode=remove; shift ;;
    --port)
      (($# >= 2)) || { echo '--port 需要端口值' >&2; exit 2; }
      port="$2"; port_set=true; shift 2 ;;
    --image) extra='[image]'; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || {
  echo '端口须在 1 到 65535 之间' >&2; exit 2;
}
if [[ "$port_set" == true && "$mode" != service ]]; then
  echo '--port 配合 --service；普通启动使用 harnesscope start --port PORT' >&2
  exit 2
fi
for command in uv node npm; do
  command -v "$command" >/dev/null || { echo "缺少 $command，请先安装后重试" >&2; exit 1; }
done
if [[ "$mode" == service ]]; then
  [[ "$(uname -s)" == Linux ]] || { echo '--service 需要 Linux systemd 用户服务' >&2; exit 1; }
  command -v systemctl >/dev/null || { echo '未找到 systemctl' >&2; exit 1; }
  systemctl --user show-environment >/dev/null || {
    echo '当前会话无法访问 systemd 用户服务，请在用户登录会话中安装' >&2; exit 1;
  }
fi

project_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
npm --prefix "$project_root/web" ci
npm --prefix "$project_root/web" run build
uv tool install --force "${project_root}${extra}"
bin_dir="$(uv tool dir --bin)"
executable="$bin_dir/harnesscope"
"$executable" --version
case "$mode" in
  service)
    "$executable" service install --port "$port"
    "$executable" restart
    ;;
  remove) "$executable" service remove ;;
  keep)
    if [[ "$(uname -s)" == Linux ]] && "$executable" status --json >/dev/null; then
      "$executable" restart
    fi
    ;;
esac
printf '\n安装完成。命令位置：%s\n' "$executable"
printf '启动：harnesscope start\n停止：harnesscope stop\n状态：harnesscope status\n'
if ! command -v harnesscope >/dev/null; then
  printf '请把 %s 加入 PATH，或使用上面的完整命令路径。\n' "$bin_dir"
fi
