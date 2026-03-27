#!/usr/bin/env bash
# CI smoke checks for Cursor `agent` in this exact job environment.
set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
MODEL="${JARVIS_AGENT_MODEL:-auto}"

echo "[jarvis-smoke] workspace=${WORKSPACE}"
echo "[jarvis-smoke] model=${MODEL}"
echo "[jarvis-smoke] cursorApiKeyPresent=$([[ -n "${CURSOR_API_KEY:-}" || -n "${JARVIS_API_KEY:-}" ]] && echo true || echo false)"

agent --version

run_probe() {
  local name="$1"
  shift

  local stdout_file
  local stderr_file
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"

  set +e
  agent "$@" >"$stdout_file" 2>"$stderr_file"
  local exit_code=$?
  set -e

  if [[ "$exit_code" -ne 0 ]]; then
    echo "::error::[jarvis-smoke] ${name} failed with exit code ${exit_code}"
    echo "--- ${name} stderr ---"
    if [[ -s "$stderr_file" ]]; then
      cat "$stderr_file"
    else
      echo "(empty)"
    fi
    echo "--- ${name} stdout ---"
    if [[ -s "$stdout_file" ]]; then
      cat "$stdout_file"
    else
      echo "(empty)"
    fi
    rm -f "$stdout_file" "$stderr_file"
    exit "$exit_code"
  fi

  echo "[jarvis-smoke] ${name} passed"
  rm -f "$stdout_file" "$stderr_file"
}

# Prove a minimal print-mode request succeeds under ask mode.
run_probe \
  "ask-json" \
  -p \
  --trust \
  --workspace "$WORKSPACE" \
  --mode=ask \
  --output-format json \
  --model "$MODEL" \
  "Reply with exactly: ok"

# Prove the same CI can execute agent mode with stream-json (the failing shape).
run_probe \
  "agent-stream-json" \
  -p \
  --force \
  --trust \
  --workspace "$WORKSPACE" \
  --mode=agent \
  --output-format stream-json \
  --model "$MODEL" \
  "Reply with exactly: ok. Do not use tools."
