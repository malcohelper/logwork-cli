#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_REPO="${1:-}"

if [ -z "$TARGET_REPO" ]; then
  cat >&2 <<USAGE
Usage:
  ./setup.sh /path/to/repo-that-you-commit-in

Example:
  ./setup.sh ~/Documents/Projects/my-app
USAGE
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install Node, then run setup again." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required. Current version: $(node --version)" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install npm, then run setup again." >&2
  exit 1
fi

if ! git -C "$TARGET_REPO" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Target path is not a Git repository: $TARGET_REPO" >&2
  exit 1
fi

cd "$SCRIPT_DIR"

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

node install.mjs "$TARGET_REPO"

cat <<DONE

Logwork Helper is ready.

Next steps:
  1. Authenticate Resource Optimiser:
       logwork-helper auth login
  2. Commit normally in: $(git -C "$TARGET_REPO" rev-parse --show-toplevel)

Manual log:
  cd "$SCRIPT_DIR"
  npm run log
DONE
