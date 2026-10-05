#!/usr/bin/env bash
# One-time prerequisites for Cantina on macOS (SPEC §15.1). Safe to re-run.
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script is for macOS. On Linux install Node 22.12+, Python 3.12, uv and FFmpeg yourself."
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Installing Homebrew…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi

brew update
brew install node@22 python@3.12 uv ffmpeg
brew link --overwrite --force node@22 || true

if [[ "${CANTINA_ACOUSTID:-0}" == "1" ]]; then brew install chromaprint; fi
if [[ "${CANTINA_OLLAMA:-0}" == "1" ]]; then brew install ollama; fi

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<12)){console.error("Node "+process.version+" is too old (need 22.12+)");process.exit(1)}'
echo
echo "Prerequisites installed: $(node -v), $(python3.12 --version), $(uv --version), $(ffmpeg -version | head -1)"
echo "Next: npm run setup"
