# Kai — Deployment Guide

Kai consists of two services and a database:

| Component | Description | Image |
|---|---|---|
| **kai-brain** | Backend agent (REST API + WebSocket gateway) | `ghcr.io/clx-labs/kai-brain` |
| **kai-face** | Frontend chat UI (React/Nginx) | `ghcr.io/clx-labs/kai-face` |
| **PostgreSQL** | Database with pgvector | `pgvector/pgvector:pg16` |

---

## Environment Variables

### kai-brain

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `JWT_SECRET` | **yes** | — | Secret for signing auth tokens (`openssl rand -base64 32`) |
| `NODE_ENV` | no | `development` | Set to `production` for deployments |
| `LLM_PROVIDER` | no | `anthropic` | `anthropic`, `openai`, `vertex`, `google` |
| `LLM_MODEL` | no | provider default | Model ID override (e.g. `gpt-4o`, `claude-sonnet-4-20250514`) |
| `OPENAI_API_KEY` | if provider=openai | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | if provider=anthropic | — | Anthropic API key |
| `SANDBOX_MODE` | no | `off` | `all` to enable python_exec and subagents |

### kai-face

| Variable | Required | Default | Description |
|---|---|---|---|
| `KAI_BRAIN_URL` | no | auto-detected | Brain REST API URL (only needed in Docker Compose) |
| `KAI_BRAIN_WS_URL` | no | auto-detected | Brain WebSocket URL (only needed in Docker Compose) |

### Config file (optional)

Mount a `config.json` to override brain defaults (model routing, sandbox mode, etc.):

```json
{
  "agent": {
    "routing": { "simple": "", "medium": "", "complex": "", "vision": "" }
  },
  "sandbox": { "mode": "all" }
}
```

Empty routing values make all requests use the primary model set by `LLM_PROVIDER`/`LLM_MODEL`.

---

## Option A: Local / Docker Compose

### Prerequisites

- Docker Desktop with Compose
- GHCR registry access

### 1. Authenticate to GHCR

```bash
echo ghp_YOUR_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Fill in:

```env
KAI_VERSION=0.0.1
POSTGRES_PASSWORD=changeme
JWT_SECRET=<openssl rand -base64 32>

LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

# Or for Anthropic:
# LLM_PROVIDER=anthropic
# ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Create `kai-brain-config.json`

```json
{
  "agent": {
    "routing": { "simple": "", "medium": "", "complex": "", "vision": "" }
  },
  "sandbox": { "mode": "all" }
}
```

### 4. Build the sandbox image

Brain needs this image to run `python_exec` and subagents:

```bash
cd kai-brain
docker build -t ava-sandbox-exec -f Dockerfile.sandbox-exec .
```

### 5. Start

```bash
docker compose -f docker-compose.production.yml up -d
```

### 6. Access

Open `http://localhost:3000`.

kai-brain requires a JWT for authentication. Generate one and set it in the browser console:

```bash
# Generate a JWT (uses JWT_SECRET from your .env)
node -e "
const crypto = require('crypto');
const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({sub:'admin',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+86400*365})).toString('base64url');
const sig = crypto.createHmac('sha256',secret).update(header+'.'+payload).digest('base64url');
console.log(header+'.'+payload+'.'+sig);
"
```

Then in the browser console at `http://localhost:3000`:

```js
localStorage.setItem("kai_token", "<paste-token-here>");
```

Refresh the page.

### 7. Update

```bash
# Pull latest images
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d
```

---

## Option B: AWS via Terraform

Managed deployment using ECS (EC2 for brain, Fargate for face), Aurora PostgreSQL, EFS, and ALB.

### What gets created

| Resource | Purpose |
|---|---|
| ECS cluster | EC2 capacity provider for brain, Fargate for face |
| EC2 Auto Scaling Group | Hosts brain containers (Docker socket access for sandbox) |
| Aurora Serverless v2 (PostgreSQL 16) | Database with pgvector |
| EFS | Persistent file storage |
| ALB | Load balancer with path-based routing (`/` → face, `/api/*` → brain, `/ws` → brain WS) |
| Security groups | Network isolation |
| SSM Parameter Store | All secrets and connection info |
| VPC (optional) | Created automatically if BYOVPC vars are omitted |

### Prerequisites

- Terraform >= 1.5
- AWS CLI configured with appropriate credentials
- S3 bucket for Terraform state

### 1. Create backend config

`kai-skeleton/env/<client>-<env>.backend.hcl`:

```hcl
bucket = "your-terraform-state-bucket"
key    = "kai/<client>/<env>/terraform.tfstate"
region = "us-east-1"
```

### 2. Create tfvars

`kai-skeleton/env/<client>-<env>.tfvars`:

```hcl
# ── Required ─────────────────────────────────────────────────
customer   = "acme"
env        = "production"
ghcr_token = "{\"username\":\"github-user\",\"password\":\"ghp_xxx\"}"
jwt_secret = "<openssl rand -base64 32>"

# ── LLM (at least one API key required) ─────────────────────
llm_provider      = "openai"        # openai | anthropic
openai_api_key    = "sk-..."        # if provider = openai
# anthropic_api_key = "sk-ant-..."  # if provider = anthropic

# ── Version ──────────────────────────────────────────────────
kai_version = "0.0.1"

# ── Sandbox ──────────────────────────────────────────────────
sandbox_enabled = true              # enables python_exec + subagents

# ── BYOVPC (optional — omit all three to create a new VPC) ──
# vpc_id             = "vpc-xxx"
# public_subnet_ids  = ["subnet-aaa", "subnet-bbb"]
# private_subnet_ids = ["subnet-ccc", "subnet-ddd"]

# ── Compute (defaults are fine for most deployments) ─────────
# brain_instance_type = "t3.medium"
# brain_cpu           = 1800
# brain_memory        = 3500
# face_cpu            = 256
# face_memory         = 512

# ── RDS ──────────────────────────────────────────────────────
# db_min_capacity        = 0.5
# db_max_capacity        = 4
# db_multi_az            = false
# db_deletion_protection = true

# ── TLS (optional — omit for HTTP-only) ─────────────────────
# certificate_arn = "arn:aws:acm:..."
# domain_name     = "example.com"
# subdomain       = "kai"
```

### 3. Init & Apply

```bash
cd kai-skeleton

terraform init -backend-config=env/<client>-<env>.backend.hcl

terraform plan  -var-file=env/<client>-<env>.tfvars
terraform apply -var-file=env/<client>-<env>.tfvars
```

### 4. DNS (if using TLS)

After apply, Terraform outputs `alb_dns_name`. Create a CNAME:

```
kai.example.com → <alb_dns_name>
```

### 5. Access

Open `https://kai.example.com` (or `http://<alb_dns_name>` without TLS).

---

## deploy.sh — CLI Helper

A convenience script at the repo root for building images and managing infrastructure.

```bash
# ── Images ─────────────────────────────────────────────
./deploy.sh build 0.0.2              # Build brain + face for linux/amd64
./deploy.sh push 0.0.2               # Push to ghcr.io
./deploy.sh build-push 0.0.2         # Build and push in one step

# ── Infrastructure ─────────────────────────────────────
./deploy.sh init somethings-production      # terraform init
./deploy.sh plan somethings-production      # terraform plan
./deploy.sh apply somethings-production     # terraform apply

# ── ECS Operations ─────────────────────────────────────
./deploy.sh redeploy somethings-production  # Force pull latest images
./deploy.sh status somethings-production    # Service status
./deploy.sh logs somethings-production      # Tail brain logs
./deploy.sh logs somethings-production face # Tail face logs

# ── Teardown ───────────────────────────────────────────
./deploy.sh destroy somethings-production
```

### GHCR token

Requires a GitHub PAT with `write:packages` scope.

GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → select `write:packages`.

```bash
echo ghp_xxx | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin
```

### CI (GitHub Actions)

Both repos have workflows that auto-build on tag pushes:

```bash
git tag v1.0.0
git push origin v1.0.0
```

### Deploy a new version

```bash
# 1. Build + push
./deploy.sh build-push 0.0.2

# 2a. Docker Compose: update KAI_VERSION in .env, then:
docker compose -f docker-compose.production.yml pull && docker compose -f docker-compose.production.yml up -d

# 2b. Terraform: update kai_version in tfvars, then:
./deploy.sh apply somethings-production
./deploy.sh redeploy somethings-production
```

---

## Database Access

The RDS database is in a private subnet. Use SSM port forwarding to connect locally.

### Prerequisites

```bash
brew install --cask session-manager-plugin
```

### Connect

```bash
# Start the tunnel (keep running)
./tunnel.sh

# In another terminal, connect via psql:
psql postgresql://kai:<password>@localhost:5433/kai
```

Or use DBeaver / TablePlus with `localhost:5433`, database `kai`, user `kai`.

The password is stored in SSM:

```bash
aws ssm get-parameter --name /kai/somethings/production/rds/password --with-decryption --query 'Parameter.Value' --output text --region us-east-1
```

---

## Terraform Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `customer` | **yes** | — | Client identifier (used in all resource names) |
| `env` | **yes** | — | Environment (`production`, `staging`, etc.) |
| `ghcr_token` | **yes** | — | JSON: `{"username":"...","password":"ghp_..."}` |
| `jwt_secret` | **yes** | — | Auth token signing secret |
| `kai_version` | no | `latest` | Docker image tag |
| `llm_provider` | no | `anthropic` | LLM provider |
| `llm_model` | no | `""` | Specific model ID override |
| `openai_api_key` | no | `""` | OpenAI API key |
| `anthropic_api_key` | no | `""` | Anthropic API key |
| `sandbox_enabled` | no | `true` | Enable python_exec + subagents |
| `brain_instance_type` | no | `t3.medium` | EC2 instance type for brain |
| `brain_cpu` | no | `900` | Brain task CPU units |
| `brain_memory` | no | `1800` | Brain task memory (MB) |
| `face_cpu` | no | `256` | Face task CPU units |
| `face_memory` | no | `512` | Face task memory (MB) |
| `brain_desired_count` | no | `1` | Brain replicas |
| `face_desired_count` | no | `1` | Face replicas |
| `vpc_id` | no | `null` | Existing VPC ID (BYOVPC) |
| `public_subnet_ids` | no | `null` | Existing public subnet IDs |
| `private_subnet_ids` | no | `null` | Existing private subnet IDs |
| `db_min_capacity` | no | `0.5` | Aurora min ACU |
| `db_max_capacity` | no | `4` | Aurora max ACU |
| `db_multi_az` | no | `false` | Multi-AZ for RDS |
| `db_deletion_protection` | no | `true` | RDS deletion protection |
| `certificate_arn` | no | `""` | ACM cert ARN for HTTPS |
| `domain_name` | no | `""` | Root domain |
| `subdomain` | no | `""` | Subdomain prefix |
