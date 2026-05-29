#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

PORT=5000
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-$PORT}"


start_service() {
    cd "${COZE_WORKSPACE_PATH}"
    if [[ -f ./.env ]]; then
      set -a
      # shellcheck disable=SC1091
      source ./.env
      set +a
    fi
    if [[ -f ./.env.local ]]; then
      set -a
      # shellcheck disable=SC1091
      source ./.env.local
      set +a
    fi
    echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
    if [[ -f ./server.js ]]; then
      NODE_ENV=production PORT=${DEPLOY_RUN_PORT} node ./server.js
      return
    fi
    if [[ -f ./output/server.js ]]; then
      cd ./output
      NODE_ENV=production PORT=${DEPLOY_RUN_PORT} node ./server.js
      return
    fi
    echo "Cannot find standalone server.js. Run pnpm build first, then start from ./output or project root."
    exit 1
}

start_service
