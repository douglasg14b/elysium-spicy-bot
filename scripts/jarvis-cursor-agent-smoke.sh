#!/usr/bin/env bash
# CI smoke checks for Cursor `agent` in this exact job environment.
set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
MODEL="${JARVIS_AGENT_MODEL:-auto}"

echo "[jarvis-smoke] workspace=${WORKSPACE}"
echo "[jarvis-smoke] model=${MODEL}"
echo "[jarvis-smoke] cursorApiKeyPresent=$([[ -n "${CURSOR_API_KEY:-}" || -n "${JARVIS_API_KEY:-}" ]] && echo true || echo false)"

agent --version
echo "[jarvis-smoke] mode help: $(agent --help | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | sed -E 's/.*(--mode[^)]*\)).*/\1/')"

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

run_probe_expect_fail() {
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

  echo "[jarvis-smoke] ${name} exit=${exit_code} (expected non-zero)"
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
  "agent-default-mode-stream-json" \
  -p \
  --trust \
  --workspace "$WORKSPACE" \
  --output-format stream-json \
  --model "$MODEL" \
  "Reply with exactly: ok. Do not use tools."

# Diagnostic: prove whether explicit --mode=agent is rejected by this CLI build.
run_probe_expect_fail \
  "agent-explicit-mode-flag" \
  -p \
  --trust \
  --workspace "$WORKSPACE" \
  --mode=agent \
  --output-format stream-json \
  --model "$MODEL" \
  "Reply with exactly: ok. Do not use tools."
