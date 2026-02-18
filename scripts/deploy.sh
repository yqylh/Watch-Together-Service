#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-remote-watching-sync}"
PID_FILE="logs/${APP_NAME}.pid"
LOG_FILE="logs/${APP_NAME}.log"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy.sh [start|stop|reset] [--yes]

Commands:
  start       安装依赖并启动服务（默认）
  stop        仅停止服务
  reset       停止服务并清空 data/covers/logs（危险操作，需加 --yes）

Examples:
  bash scripts/deploy.sh
  bash scripts/deploy.sh stop
  bash scripts/deploy.sh reset --yes
EOF
}

stop_nohup_process() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 0
  fi

  local old_pid
  old_pid="$(cat "$PID_FILE" || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    echo "[deploy] 停止进程 PID=$old_pid"
    kill "$old_pid" || true
    sleep 1
  else
    echo "[deploy] PID 文件存在但进程已退出，清理 PID 文件"
  fi

  rm -f "$PID_FILE"
}

stop_service() {
  local stopped=0

  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    echo "[deploy] 使用 pm2 停止服务"
    pm2 stop "$APP_NAME"
    pm2 save >/dev/null 2>&1 || true
    stopped=1
  fi

  if [[ -f "$PID_FILE" ]]; then
    stop_nohup_process
    stopped=1
  fi

  if [[ "$stopped" -eq 0 ]]; then
    echo "[deploy] 未发现运行中的服务"
    return 0
  fi

  echo "[deploy] 服务已停止"
}

clear_runtime_data() {
  mkdir -p data covers logs
  echo "[deploy] 清空运行数据目录: data/ covers/ logs/"
  find data -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  find covers -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
  find logs -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  echo "[deploy] 数据已清空"
}

start_service() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[deploy] 未检测到 node，请先安装 Node.js 18+"
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "[deploy] 未检测到 npm，请先安装 npm"
    exit 1
  fi

  echo "[deploy] node: $(node -v)"
  echo "[deploy] npm: $(npm -v)"
  echo "[deploy] 安装依赖..."
  npm install --omit=dev

  if [[ ! -f .env ]]; then
    echo "[deploy] 未发现 .env，基于 .env.example 创建"
    cp .env.example .env
  fi

  mkdir -p data covers logs

  local port host display_host
  port="$(grep -E '^PORT=' .env | tail -n 1 | cut -d '=' -f 2- || true)"
  port="${port:-3000}"
  host="$(grep -E '^HOST=' .env | tail -n 1 | cut -d '=' -f 2- || true)"
  host="${host:-0.0.0.0}"
  display_host="$host"
  if [[ "$host" == "0.0.0.0" ]]; then
    display_host="localhost"
  fi

  if command -v pm2 >/dev/null 2>&1; then
    echo "[deploy] 使用 pm2 启动服务"
    stop_nohup_process
    if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
      pm2 restart "$APP_NAME" --update-env
    else
      pm2 start server.js --name "$APP_NAME" --update-env
    fi
    pm2 save >/dev/null 2>&1 || true
    pm2 status "$APP_NAME"
    echo "[deploy] 访问地址: http://${display_host}:${port} (bind ${host})"
    return 0
  fi

  stop_nohup_process
  echo "[deploy] 使用 nohup 启动服务"
  nohup node server.js >> "$LOG_FILE" 2>&1 &
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"

  echo "[deploy] 启动完成 PID=$new_pid"
  echo "[deploy] 日志文件: $LOG_FILE"
  echo "[deploy] 访问地址: http://${display_host}:${port} (bind ${host})"
}

ACTION="${1:-start}"
shift || true

CONFIRM_RESET=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)
      CONFIRM_RESET=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[deploy] 未知参数: $arg"
      usage
      exit 1
      ;;
  esac
done

case "$ACTION" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  reset)
    if [[ "$CONFIRM_RESET" -ne 1 ]]; then
      echo "[deploy] reset 会删除所有运行数据，请添加 --yes 确认"
      exit 1
    fi
    stop_service
    clear_runtime_data
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "[deploy] 未知命令: $ACTION"
    usage
    exit 1
    ;;
esac
