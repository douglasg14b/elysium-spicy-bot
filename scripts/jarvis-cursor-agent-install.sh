#!/usr/bin/env bash
# Installs Cursor's `agent` CLI for Jarvis GitHub Actions. Requires a pinned checksum (repository variable).
set -euo pipefail

if [ -z "${JARVIS_INSTALL_SCRIPT_SHA256:-}" ]; then
  echo "::error::Set repository Actions variable JARVIS_INSTALL_SCRIPT_SHA256 to the sha256sum of the install script (see AGENTS.md — Jarvis)."
  exit 1
fi

CURSOR_CLI_INSTALL_URL="${CURSOR_CLI_INSTALL_URL:-https://cursor.com/install}"
script=/tmp/jarvis-agent-install.sh
curl -fsSL "$CURSOR_CLI_INSTALL_URL" -o "$script"
echo "${JARVIS_INSTALL_SCRIPT_SHA256}  ${script}" | sha256sum -c -
bash "$script"
echo "$HOME/.cursor/bin" >> "$GITHUB_PATH"
agent --version
