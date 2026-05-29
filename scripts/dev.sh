#!/bin/bash
set -Eeuo pipefail


PORT=5001
COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT}}"


cd "${COZE_WORKSPACE_PATH}"

kill_port_if_listening() {
    local pids
    if command -v lsof >/dev/null 2>&1; then
      pids=$(lsof -tiTCP:"${DEPLOY_RUN_PORT}" -sTCP:LISTEN 2>/dev/null | paste -sd' ' - || true)
    elif command -v ss >/dev/null 2>&1; then
      pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    else
      pids=""
    fi

    if [[ -z "${pids}" ]]; then
      echo "Port ${DEPLOY_RUN_PORT} is free."
      return
    fi
    echo "Port ${DEPLOY_RUN_PORT} in use by PIDs: ${pids} (SIGKILL)"
    echo "${pids}" | xargs -I {} kill -9 {}
    sleep 1
    if command -v lsof >/dev/null 2>&1; then
      pids=$(lsof -tiTCP:"${DEPLOY_RUN_PORT}" -sTCP:LISTEN 2>/dev/null | paste -sd' ' - || true)
    elif command -v ss >/dev/null 2>&1; then
      pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    else
      pids=""
    fi

    if [[ -n "${pids}" ]]; then
      echo "Warning: port ${DEPLOY_RUN_PORT} still busy after SIGKILL, PIDs: ${pids}"
    else
      echo "Port ${DEPLOY_RUN_PORT} cleared."
    fi
}

echo "Clearing port ${DEPLOY_RUN_PORT} before start."
kill_port_if_listening
echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for dev..."

# Next.js 16 默认使用 Turbopack；当前中文项目路径会触发 Turbopack char-boundary panic。
# 明确使用官方 --webpack 参数，避免启动后 500 Internal Server Error。
NEXT_TELEMETRY_DISABLED=1 PORT=${DEPLOY_RUN_PORT} pnpm next dev --webpack
