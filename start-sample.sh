#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

: "${PORT:=18080}"
: "${AZURE_OPENAI_REASONING_EFFORT:=medium}"
: "${AZURE_OPENAI_VERBOSITY:=medium}"
: "${AZURE_OPENAI_DEBUG_LOGS:=}"
: "${AZURE_OPENAI_ORIGIN:=https://your-resource.openai.azure.com}"

if [[ "$AZURE_OPENAI_ORIGIN" == "https://your-resource.openai.azure.com" ]]; then
  cat <<'EOF'
Set AZURE_OPENAI_ORIGIN before running this script.

Example:
  AZURE_OPENAI_ORIGIN="https://<resource-name>.openai.azure.com" ./start-sample.sh
EOF
  exit 1
fi

echo "Starting proxy on port $PORT"
echo "Reasoning effort: $AZURE_OPENAI_REASONING_EFFORT"
echo "Verbosity: $AZURE_OPENAI_VERBOSITY"
if [[ "$AZURE_OPENAI_DEBUG_LOGS" =~ ^(1|true|yes|on)$ ]]; then
  echo "Debug response logging: enabled"
else
  echo "Debug response logging: disabled"
fi
exec npm start
