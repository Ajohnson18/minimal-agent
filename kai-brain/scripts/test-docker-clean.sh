#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[docker-clean] stopping compose services"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true

echo "[docker-clean] removing explicit smoke containers"
docker rm -f ava-postgres ava-browser-sandbox >/dev/null 2>&1 || true

echo "[docker-clean] removing sandbox exec containers"
SANDBOX_IDS="$(docker ps -aq --filter name=ava-sandbox- 2>/dev/null || true)"
if [[ -n "${SANDBOX_IDS}" ]]; then
  docker rm -f ${SANDBOX_IDS} >/dev/null 2>&1 || true
fi

echo "[docker-clean] cleanup complete"
