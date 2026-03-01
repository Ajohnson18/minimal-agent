#!/bin/bash
# Git credential helper for xava-bot GitHub App
# Generates a fresh installation token on each push
# Usage: git config --global credential.helper '/path/to/git-credential-helper.sh'

if [ "$1" != "get" ]; then
  exit 0
fi

# Read stdin to check if it's for github.com
INPUT=$(cat)
HOST=$(echo "$INPUT" | grep "^host=" | cut -d= -f2)

if [ "$HOST" != "github.com" ]; then
  exit 0
fi

# Generate fresh token
TOKEN_OUTPUT=$(bash "$(dirname "$0")/github-app-auth.sh" 2>/dev/null)
TOKEN=$(echo "$TOKEN_OUTPUT" | grep "^export GITHUB_TOKEN=" | cut -d= -f2)

if [ -z "$TOKEN" ]; then
  exit 1
fi

echo "protocol=https"
echo "host=github.com"
echo "username=x-access-token"
echo "password=${TOKEN}"
