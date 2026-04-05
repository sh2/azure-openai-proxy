#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

: "${PORT:=18080}"
: "${AZURE_OPENAI_REASONING_EFFORT:=medium}"
: "${AZURE_OPENAI_VERBOSITY:=medium}"
: "${AZURE_OPENAI_ENDPOINT:=https://your-resource.openai.azure.com}"

if [[ "$AZURE_OPENAI_ENDPOINT" == "https://your-resource.openai.azure.com" ]]; then
  cat <<'EOF'
Set AZURE_OPENAI_ENDPOINT before running this script.

Example:
  AZURE_OPENAI_ENDPOINT="https://<resource-name>.openai.azure.com" ./start-sample.sh
EOF
  exit 1
fi

echo "Starting proxy on port $PORT"
exec npm start
