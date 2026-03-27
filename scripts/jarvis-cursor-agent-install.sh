#!/usr/bin/env bash
# Runs the vendored Cursor install script (pinned in-repo); then exposes `agent` on PATH for Actions.
#
# Refresh vendor/cursor-com-install.sh from upstream when bumping the installer:
#   curl -fsSL "${CURSOR_COM_INSTALL_SCRIPT_URL}" -o scripts/vendor/cursor-com-install.sh
set -euo pipefail

readonly CURSOR_COM_INSTALL_SCRIPT_URL="https://cursor.com/install"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="${SCRIPT_DIR}/vendor/cursor-com-install.sh"

if [[ ! -f "$INSTALL_SCRIPT" ]]; then
  echo "::error::Missing vendored Cursor install script at ${INSTALL_SCRIPT} — fetch from ${CURSOR_COM_INSTALL_SCRIPT_URL} (see header in this file)."
  exit 1
fi

bash "$INSTALL_SCRIPT"

export PATH="${HOME}/.local/bin:${PATH}"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${HOME}/.local/bin" >> "$GITHUB_PATH"
fi

agent --version
