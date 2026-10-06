#!/bin/bash
# Installs dependencies in Claude Code cloud sessions so tests, typecheck and e2e can run.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
# Electron's binary isn't needed for tests or the browser e2e (CI skips it too).
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm install --no-audit --no-fund
