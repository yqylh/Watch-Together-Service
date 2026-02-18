#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-remote-watching-sync}"
cd "$ROOT_DIR"

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

PORT="$(grep -E '^PORT=' .env | tail -n 1 | cut -d '=' -f 2- || true)"
PORT="${PORT:-3000}"

if command -v pm2 >/dev/null 2>&1; then
  echo "[deploy] 使用 pm2 启动服务"
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
  else
    pm2 start server.js --name "$APP_NAME" --update-env
  fi
  pm2 save >/dev/null 2>&1 || true
  pm2 status "$APP_NAME"
  echo "[deploy] 访问地址: http://localhost:${PORT}"
  exit 0
fi

PID_FILE="logs/${APP_NAME}.pid"
LOG_FILE="logs/${APP_NAME}.log"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    echo "[deploy] 停止旧进程 PID=$OLD_PID"
    kill "$OLD_PID" || true
    sleep 1
  fi
fi

echo "[deploy] 使用 nohup 启动服务"
nohup node server.js >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

echo "[deploy] 启动完成 PID=$NEW_PID"
echo "[deploy] 日志文件: $LOG_FILE"
echo "[deploy] 访问地址: http://localhost:${PORT}"
