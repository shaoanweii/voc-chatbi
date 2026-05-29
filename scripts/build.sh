#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

cd "${COZE_WORKSPACE_PATH}"

echo "Installing dependencies..."
pnpm install --prefer-frozen-lockfile --prefer-offline --loglevel debug --reporter=append-only

echo "Building the Next.js project..."
NEXT_TELEMETRY_DISABLED=1 pnpm next build --webpack

echo "Cleaning up and organizing standalone output..."
rm -rf ./output
mkdir -p ./output

cp -R ./.next/standalone/. ./output/
mkdir -p ./output/.next
rm -rf ./output/.next/static
cp -R ./.next/static ./output/.next/static
if [[ -d ./public ]]; then
  rm -rf ./output/public
  cp -R ./public ./output/public
fi
cp ./scripts/start.sh ./output/start.sh
chmod +x ./output/start.sh

echo "Build completed successfully!"
echo "Output directory: ./output"
