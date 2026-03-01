# AVA Auth Guide

## Summary
AVA now enforces JWT auth on non-Slack HTTP and WebSocket surfaces.
Slack endpoints remain signature-based and do not require bearer tokens.

## JWT Requirements
- Algorithm: `HS256`
- Signing key: `JWT_SECRET`
- Canonical user claim: `sub`
- Backward compatibility: `user_id` is accepted only if `sub` is missing

Optional claim checks (when configured):
- `iss` via `server.auth.issuer` / `AVA_AUTH_ISSUER`
- `aud` via `server.auth.audience` / `AVA_AUTH_AUDIENCE`

## Protected HTTP Endpoints
These now require `Authorization: Bearer <token>`:
- `POST /api/ava/chat`
- `GET /api/ava/chat/history/:session_id`
- `GET /api/ava/sessions`
- `GET /api/ava/sessions/:id`
- `POST /api/ava/sessions`
- `DELETE /api/ava/sessions/:id`

Notes:
- Request `user_id` fallback is removed from HTTP route behavior.
- Route identity is always taken from `req.auth.userId`.

## Protected WebSocket Endpoint
- `WS /ws`

Auth methods:
- Preferred: `Authorization: Bearer <token>` header
- Optional (browser compatibility): `?token=<jwt>` if `server.auth.wsAllowQueryToken=true`

Unauthenticated WS connections are closed with code `4401`.

## Slack Exception
`/api/ava/slack/*` continues to use Slack HMAC signature verification only:
- `X-Slack-Signature`
- `X-Slack-Request-Timestamp`

Bearer tokens are ignored for Slack route auth decisions.

## Config
`config.json`:

```json
{
  "server": {
    "auth": {
      "required": true,
      "wsAllowQueryToken": true,
      "issuer": "",
      "audience": ""
    }
  }
}
```

Env overrides:
- `AVA_AUTH_REQUIRED`
- `AVA_WS_ALLOW_QUERY_TOKEN`
- `AVA_AUTH_ISSUER`
- `AVA_AUTH_AUDIENCE`
