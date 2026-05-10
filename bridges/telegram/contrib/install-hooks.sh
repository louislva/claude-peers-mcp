#!/usr/bin/env bash
# Set this repo to use .githooks/ for hooks (per-repo, no global side effects).
# Run once after cloning: bash bridges/telegram/contrib/install-hooks.sh
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
git -C "$repo_root" config core.hooksPath .githooks
chmod +x "$repo_root/.githooks/pre-commit"

echo "Configured core.hooksPath = .githooks"
echo "pre-commit hook is now active for this repo."
