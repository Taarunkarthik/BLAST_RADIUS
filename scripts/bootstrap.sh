#!/usr/bin/env bash
# One-command, idempotent BlastRadius setup for macOS and Linux.
#
# Usage: scripts/bootstrap.sh [extras]
#   extras defaults to "harness"; pass "" for the base package only or a
#   comma-separated list such as "harness,postgres".
set -euo pipefail

EXTRAS="${1:-harness}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

PYTHON=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PYTHON="$candidate"
        break
    fi
done
[ -n "$PYTHON" ] || fail "Python 3.11+ is required but neither 'python3' nor 'python' was found on PATH. Install it from https://www.python.org/downloads/ and reopen the terminal."

if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
    found="$("$PYTHON" -c 'import platform; print(platform.python_version())' 2>/dev/null || echo unknown)"
    fail "Python $found was found, but BlastRadius needs Python 3.11 or newer. Install a newer Python and try again."
fi

if [ -x ".venv/bin/python" ]; then
    VENV_PYTHON=".venv/bin/python"
    BIN_DIR=".venv/bin"
elif [ -x ".venv/Scripts/python.exe" ]; then
    VENV_PYTHON=".venv/Scripts/python.exe"
    BIN_DIR=".venv/Scripts"
else
    echo "Creating .venv ..."
    "$PYTHON" -m venv .venv || fail "Could not create .venv. Delete any partial .venv directory and try again."
    if [ -x ".venv/bin/python" ]; then
        VENV_PYTHON=".venv/bin/python"
        BIN_DIR=".venv/bin"
    else
        VENV_PYTHON=".venv/Scripts/python.exe"
        BIN_DIR=".venv/Scripts"
    fi
fi
[ -x "$VENV_PYTHON" ] || fail "The .venv directory exists but $VENV_PYTHON is missing. Delete .venv and run this script again."

if [ -z "$EXTRAS" ]; then
    TARGET="."
else
    TARGET=".[$EXTRAS]"
fi
echo "Installing BlastRadius ($TARGET) ..."
"$VENV_PYTHON" -m pip install --disable-pip-version-check -e "$TARGET" \
    || fail "Dependency installation failed. Check your network connection and try again."

command -v node >/dev/null 2>&1 \
    || fail "Node.js 20+ is required but 'node' was not found on PATH. Install it from https://nodejs.org and reopen the terminal."
command -v npm >/dev/null 2>&1 \
    || fail "npm is required but was not found on PATH. Reinstall Node.js 20+ (npm is bundled) and reopen the terminal."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
    fail "Node.js ${NODE_MAJOR} was found, but BlastRadius needs Node.js 20 or newer. Install it from https://nodejs.org."
fi

echo "Installing the pinned parser runtime ..."
"$VENV_PYTHON" -m blastradius setup || fail "Parser setup failed. Run 'blastradius doctor' for details."

printf '\nBlastRadius is ready.\n'
printf 'Next: %s/blastradius scan --path examples/demo\n' "$BIN_DIR"
printf 'UI:   %s/blastradius harness --path .\n' "$BIN_DIR"
