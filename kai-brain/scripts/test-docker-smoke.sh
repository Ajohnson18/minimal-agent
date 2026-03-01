#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_FILE="/tmp/ava-docker-smoke.log"
APP_PID=""
export AVA_SMOKE_USER_ID="${AVA_SMOKE_USER_ID:-docker-smoke-user}"

on_error() {
  local exit_code=$?
  echo "[docker-smoke] failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}"
  if [[ -f "$LOG_FILE" ]]; then
    echo "[docker-smoke] tailing app log (${LOG_FILE})"
    tail -n 200 "$LOG_FILE" || true
  fi
  exit "$exit_code"
}

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" >/dev/null 2>&1; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  bash "$ROOT_DIR/scripts/test-docker-clean.sh"
}

trap on_error ERR
trap cleanup EXIT

export NODE_ENV="test"
export AVA_TEST_MODE="1"
export AVA_CONFIG_PATH="${AVA_CONFIG_PATH:-$ROOT_DIR/test/fixtures/config.test.json}"
export DATABASE_URL="${AVA_TEST_DB_URL:-postgresql://ava:ava_dev_password@127.0.0.1:5433/ava_dev}"
export AVA_TEST_DB_URL="$DATABASE_URL"
export JWT_SECRET="${JWT_SECRET:-ava-test-jwt-secret}"
export VERTEX_AI_PROJECT_ID="${VERTEX_AI_PROJECT_ID:-ava-test-project}"
export VERTEX_AI_SERVICE_ACCOUNT_KEY="${VERTEX_AI_SERVICE_ACCOUNT_KEY:-{\"type\":\"service_account\",\"project_id\":\"ava-test-project\"}}"
export SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-test-signing-secret}"
export SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-xoxb-test-token}"
export CREDENTIAL_ENCRYPTION_KEY="${CREDENTIAL_ENCRYPTION_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"

# Auth-required runtime defaults
export AVA_AUTH_REQUIRED="${AVA_AUTH_REQUIRED:-1}"
export AVA_WS_ALLOW_QUERY_TOKEN="${AVA_WS_ALLOW_QUERY_TOKEN:-1}"

# Sandbox/browser smoke defaults
export SANDBOX_MODE="${SANDBOX_MODE:-all}"
export SANDBOX_SCOPE="${SANDBOX_SCOPE:-user}"
export SANDBOX_NETWORK="${SANDBOX_NETWORK:-bridge}"
export SANDBOX_IMAGE="${SANDBOX_IMAGE:-ava-sandbox-exec}"
export BROWSER_MODE="${BROWSER_MODE:-sandbox}"
export BROWSER_CDP_URL="${BROWSER_CDP_URL:-http://127.0.0.1:9222}"

if ! docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
  echo "[docker-smoke] sandbox image '$SANDBOX_IMAGE' not found, building it"
  docker build -t "$SANDBOX_IMAGE" -f Dockerfile.sandbox-exec .
fi

pnpm sandbox:verify-image >/dev/null

echo "[docker-smoke] starting postgres + browser sandbox"
docker compose up -d postgres browser-sandbox

echo "[docker-smoke] waiting for postgres"
for i in {1..90}; do
  if docker compose exec -T postgres pg_isready -U ava -d ava_dev >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 90 ]]; then
    echo "[docker-smoke] postgres did not become ready"
    exit 1
  fi
  sleep 1
done

echo "[docker-smoke] waiting for browser CDP"
for i in {1..90}; do
  if curl -fsS "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 90 ]]; then
    echo "[docker-smoke] browser sandbox did not become ready"
    exit 1
  fi
  sleep 1
done

echo "[docker-smoke] applying schema"
pnpm db:push:ci >/dev/null

echo "[docker-smoke] starting API + gateway"
pnpm tsx src/index.ts >"$LOG_FILE" 2>&1 &
APP_PID="$!"

echo "[docker-smoke] waiting for health endpoint"
for i in {1..90}; do
  if curl -fsS "http://127.0.0.1:3001/health" >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 90 ]]; then
    echo "[docker-smoke] API did not become healthy"
    exit 1
  fi
  sleep 1
done

AUTH_TOKEN="$(node --input-type=module <<'EOF_NODE'
import { createHmac } from 'node:crypto';
const secret = process.env.JWT_SECRET;
const userId = process.env.AVA_SMOKE_USER_ID ?? 'docker-smoke-user';
const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: userId, iat: now, exp: now + 3600 })).toString('base64url');
const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
process.stdout.write(`${header}.${payload}.${signature}`);
EOF_NODE
)"

echo "[docker-smoke] checking health endpoints"
curl -fsS "http://127.0.0.1:3001/health" >/dev/null
curl -fsS "http://127.0.0.1:3001/api/ava/health/live" >/dev/null
curl -fsS "http://127.0.0.1:3001/api/ava/health/ready" >/dev/null

echo "[docker-smoke] checking authenticated HTTP endpoints"
curl -fsS "http://127.0.0.1:3001/api/ava/sessions" \
  -H "authorization: Bearer ${AUTH_TOKEN}" >/dev/null

echo "[docker-smoke] checking authenticated gateway rpc methods"
SMOKE_TOKEN="$AUTH_TOKEN" node --input-type=module <<'EOF_NODE'
import { WebSocket } from 'ws';

function rpc(ws, method, params = {}) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`timeout for ${method}`));
    }, 12000);

    const onMessage = (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.id !== id) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(payload);
    };

    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const token = process.env.SMOKE_TOKEN;
const ws = new WebSocket('ws://127.0.0.1:18789/ws', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

const checks = [
  ['queue.stats', {}],
  ['cron.list', {}],
  ['browser.status', {}],
  ['browser.navigate', { url: 'https://example.com' }],
];

for (const [method, params] of checks) {
  const response = await rpc(ws, method, params);
  if (response.error) {
    throw new Error(`${method} failed: ${response.error.message}`);
  }
}

ws.close();
EOF_NODE

echo "[docker-smoke] checking python sandbox execution via container manager"
node --import tsx --input-type=module <<'EOF_NODE' >/dev/null
import { ensureContainer, execInContainer } from './src/sandbox/container-manager.ts';

const hostWorkspaceDir = process.cwd() + '/.sandbox/docker-smoke/workspace';
const container = await ensureContainer('docker-smoke', {
  image: process.env.SANDBOX_IMAGE ?? 'ava-sandbox-exec',
  memory: '512m',
  cpus: '1',
  network: 'none',
  workdir: '/workspace',
  hostWorkspaceDir,
  idleTimeoutMs: 600000,
});

const result = await execInContainer(
  container,
  "python3 -c 'print(40+2)'",
  {},
  '/workspace',
  10000,
);

if (result.exitCode !== 0 || !result.stdout.includes('42')) {
  throw new Error(`python sandbox smoke failed: ${result.stderr || result.stdout}`);
}
EOF_NODE

if [[ "${AVA_LIVE_TESTS:-0}" == "1" ]]; then
  echo "[docker-smoke] live gate enabled, running minimal /api/ava/chat smoke"
  RESPONSE_FILE="$(mktemp)"
  curl -fsS "http://127.0.0.1:3001/api/ava/chat" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${AUTH_TOKEN}" \
    -d "{\"message\":\"Reply with ok\"}" > "$RESPONSE_FILE"

  if ! grep -q '"type":"done"' "$RESPONSE_FILE"; then
    echo "[docker-smoke] live chat smoke failed"
    cat "$RESPONSE_FILE"
    exit 1
  fi
  rm -f "$RESPONSE_FILE"
fi

echo "[docker-smoke] smoke checks passed"
