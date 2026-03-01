#!/bin/bash
# GitHub App Auth - generates an installation access token
# Usage: source github-app-auth.sh
#        or: eval $(bash github-app-auth.sh)
# If GITHUB_TOKEN is already set (e.g. from stored credentials), re-exports it and exits.

set -euo pipefail

if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "export GITHUB_TOKEN=${GITHUB_TOKEN}"
  exit 0
fi

APP_ID="2871746"
INSTALLATION_ID="110323001"
PEM_FILE="$HOME/.ava/secrets/xava-bot.pem"

# Generate JWT (valid for 10 min)
NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 600))

# Create JWT header and payload
HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
PAYLOAD=$(echo -n "{\"iat\":${IAT},\"exp\":${EXP},\"iss\":\"${APP_ID}\"}" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

# Sign it
SIGNATURE=$(echo -n "${HEADER}.${PAYLOAD}" | openssl dgst -sha256 -sign "$PEM_FILE" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

JWT="${HEADER}.${PAYLOAD}.${SIGNATURE}"

# Exchange JWT for installation access token
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer ${JWT}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens")

TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get token. Response: $RESPONSE" >&2
  exit 1
fi

echo "export GITHUB_TOKEN=${TOKEN}"
