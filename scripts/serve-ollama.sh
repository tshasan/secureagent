#!/usr/bin/env bash
# Copyright 2026 Taimur Hasan
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Bun-native replacement for the old Nix dev shell's ollama bootstrap.
# Starts `ollama serve` in the background if it is not already up, sets
# OLLAMA_NUM_PARALLEL so the runner's concurrent requests actually run in
# parallel, waits until the API is reachable, and writes logs to .ollama/.
#
# Idempotent: if ollama is already serving, it leaves it alone. Stop a server
# this script started with `scripts/serve-ollama.sh stop`.
set -euo pipefail

cd "$(dirname "$0")/.."

OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
# Keep this >= SECUREAGENT_CONCURRENCY (runner default 4) or concurrent runs
# queue inside ollama instead of overlapping.
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-4}"

case "$OLLAMA_HOST" in
  http://*|https://*) url="$OLLAMA_HOST" ;;
  *) url="http://$OLLAMA_HOST" ;;
esac

mkdir -p .ollama

if [ "${1:-}" = "stop" ]; then
  if [ -f .ollama/serve.pid ]; then
    kill "$(cat .ollama/serve.pid)" 2>/dev/null || true
    rm -f .ollama/serve.pid
    echo "Stopped ollama (was started by this script)."
  else
    echo "No ollama server recorded by this script (.ollama/serve.pid absent)."
  fi
  exit 0
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "ERROR: 'ollama' not found on PATH. Install it from https://ollama.com" >&2
  exit 1
fi

if curl -sf "$url/api/tags" >/dev/null 2>&1; then
  echo "ollama already running at $url (leaving it as-is)"
  exit 0
fi

echo "Starting ollama at $url (OLLAMA_NUM_PARALLEL=$OLLAMA_NUM_PARALLEL)..."
OLLAMA_HOST="$OLLAMA_HOST" ollama serve >.ollama/serve.log 2>&1 &
echo $! >.ollama/serve.pid

for _ in $(seq 1 30); do
  if curl -sf "$url/api/tags" >/dev/null 2>&1; then
    echo "ollama ready (pid $(cat .ollama/serve.pid), logs in .ollama/serve.log)"
    exit 0
  fi
  sleep 0.5
done

echo "WARNING: ollama did not become ready in 15s. See .ollama/serve.log" >&2
exit 1
