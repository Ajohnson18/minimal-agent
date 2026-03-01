# AVA Agent — AWS Deployment

## Architecture

AVA runs on a dedicated EC2 instance in the `somethings-infra-mm` production VPC (`10.1.0.0/16`). It connects to its own RDS for session/memory storage, and to the Somethings production RDS (in the old infra VPC `10.2.0.0/16`) via VPC peering for read-only SQL queries.

```
                          ┌─────────────────────────────────────────────┐
                          │  somethings-infra-mm Production VPC         │
                          │  10.1.0.0/16                                │
Internet ──► ALB ────────►│  EC2 (m5.xlarge, Ubuntu 22.04)              │
             :443         │    ├── AVA Node.js app (:3001 API, :18789 WS)
                          │    ├── Python sandbox containers (Docker)   │
                          │    └── Browser sandbox container (Docker)   │
                          │                                             │
                          │  AVA RDS (PostgreSQL 15 + pgvector)         │
                          └──────────────┬──────────────────────────────┘
                                         │ VPC Peering (pcx-05fd37580f4853c44)
                          ┌──────────────┴──────────────────────────────┐
                          │  Old Somethings VPC                         │
                          │  10.2.0.0/16 (vpc-0e58d8977c04222fa)       │
                          │                                             │
                          │  Somethings RDS (PostgreSQL, db=production) │
                          └─────────────────────────────────────────────┘
```

## Infrastructure (Terraform)

All infra lives in `somethings-infra-mm/ava/` — a **separate Terraform root** with its own state file. Running `terraform apply` in `ava/` cannot affect any other infrastructure.

### Key Details

| Item | Value |
|------|-------|
| Terraform state | `s3://somethings-terraform-state/somethings/ava/terraform.tfstate` |
| EC2 instance | `i-081c82b59f85c8ea2` (m5.xlarge, private subnet) |
| EC2 private IP | `10.1.33.131` |
| ALB DNS | `somethings-production-ava-alb-100679223.us-east-1.elb.amazonaws.com` |
| DNS CNAME | `ava.somethings.com` → ALB DNS |
| SSL cert | `arn:aws:acm:us-east-1:306484752483:certificate/dc45c1d3-f03d-463f-89b5-3e1eafce04c4` (wildcard `*.somethings.com`) |
| AVA RDS | `somethings-production-ava-rds.c1k2usmmczoo.us-east-1.rds.amazonaws.com` (db=`ava`) |
| AVA RDS password SSM | `/somethings-production-ava/rds/password` |
| Somethings prod RDS | `somethings.c1k2usmmczoo.us-east-1.rds.amazonaws.com` (db=`production`) |
| VPC peering | `pcx-05fd37580f4853c44` (10.1.0.0/16 ↔ 10.2.0.0/16) |
| IAM role | `somethings-production-ava-ec2-role` |

### Terraform Files

```
somethings-infra-mm/ava/
├── main.tf              # Provider, S3 backend, SSM data sources, Ubuntu AMI
├── variables.tf         # All inputs (instance type, certs, RDS config, peering config)
├── outputs.tf           # ALB DNS, instance ID, RDS endpoint
├── iam.tf               # IAM role: SSM Session Manager, SSM param read, readonly observability
├── ec2.tf               # EC2 instance + security group
├── alb.tf               # ALB, target groups (API :3001, WS :18789), HTTPS listener
├── rds.tf               # AVA's own RDS via ../modules/rds_postgres
├── somethings_rds.tf    # VPC peering + routes + SG rule for Somethings prod RDS
├── ssm.tf               # Publishes AVA params to SSM
├── user_data.sh         # EC2 bootstrap (Docker, Node.js 22, pnpm, systemd, AWS CLI)
└── env/
    ├── staging.tfvars
    └── production.tfvars
```

### Deploy / Destroy

```bash
cd somethings-infra-mm/ava

# Deploy
terraform init
terraform plan -var-file=env/production.tfvars
terraform apply -var-file=env/production.tfvars

# Destroy (tears down everything cleanly, including peering + SG rules)
terraform destroy -var-file=env/production.tfvars
```

## EC2 Instance Setup

### Access

SSH-less access via SSM Session Manager:

```bash
aws ssm start-session --target i-081c82b59f85c8ea2
sudo su - ubuntu
```

### Automated Setup

The setup script at `dev/setup_ava.sh` automates the full instance configuration:

```bash
bash dev/setup_ava.sh <GITHUB_PAT> [SOMETHINGS_DB_PASSWORD]
```

It handles: git credentials, repo clone, pnpm install, .env generation (pulls AVA RDS creds from SSM, looks up Somethings RDS endpoint automatically), db:push, Docker sandbox image builds, and systemd service setup.

### Manual Setup (if needed)

1. **Prerequisites** (installed by user_data.sh on boot):
   - Docker + Docker Compose
   - Node.js 22 + pnpm 9
   - AWS CLI v2

2. **Git credentials** (org-wide read access):
   ```bash
   git config --global url."https://<PAT>@github.com/".insteadOf "https://github.com/"
   ```

3. **Clone and install**:
   ```bash
   cd /opt/ava
   git clone https://github.com/Somethings/ava-agent.git .
   pnpm install --frozen-lockfile
   ```

4. **pgvector extension** (required before db:push):
   ```bash
   sudo apt-get install -y postgresql-client
   psql "<AVA_DATABASE_URL>" -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```

5. **Database migrations**:
   ```bash
   node --import tsx node_modules/drizzle-kit/bin.cjs push
   ```

6. **Docker sandbox images**:
   ```bash
   docker build -t ava-sandbox -f Dockerfile.sandbox .
   docker build -t ava-browser-sandbox -f Dockerfile.sandbox-browser .
   ```

7. **Systemd service** (`/etc/systemd/system/ava.service`):
   - Uses `npx tsx src/index.ts` (not `node dist/index.js` — needed because `@isaacraja/pi-vertex-claude` ships raw .ts files)
   - EnvironmentFile: `/opt/ava/.env`
   - Auto-restarts on failure

8. **Start**:
   ```bash
   sudo systemctl enable ava
   sudo systemctl start ava
   journalctl -u ava -f
   ```

## Environment Variables

The `.env` file at `/opt/ava/.env` contains all configuration. Key entries:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | AVA's own RDS (PostgreSQL + pgvector) |
| `SOMETHINGS_DB_URL` | Somethings production RDS (read-only via sql_query tool, db=`production`) |
| `VERTEX_AI_PROJECT_ID` | Google Cloud project for Vertex AI |
| `VERTEX_AI_SERVICE_ACCOUNT_KEY` | Service account JSON for Vertex AI |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `JWT_SECRET` | Auto-generated on setup |
| `BROWSER_MODE` | `sandbox` (uses Docker container) |

**Important**: The `DATABASE_URL` must use `?sslmode=require&uselibpqcompat=true` to work with RDS. Passwords with special characters must be URL-encoded.

## IAM Role Permissions

The EC2 instance profile (`somethings-production-ava-ec2-role`) has:

- **SSM Session Manager** — SSH-less access to the instance
- **SSM Parameter Store read** — `/somethings/production/*` and `/somethings-production-ava/*`
- **Readonly observability** — CloudWatch Logs/Metrics, ECS, RDS, EC2 describe (for future log analysis features)

## Codebase Access

Repos are cloned at `/opt/ava/workspace/repos/`:

- `somethings-api` — main backend
- `somethings-reporting` — ETL/reporting
- `somethings-mentor-dashboard` — mentor dashboard frontend
- `somethings-ui` — shared UI components
- `mono` — monorepo (mobile app at `mono/link-v2`)

Git credentials are configured with a fine-grained PAT (Somethings/withlink org, all repos, read-only).

To update repos: `cd /opt/ava/workspace/repos/<repo> && git pull`

## Skills

AVA discovers skills from `~/.ava/skills/` on the EC2. The `somethings` skill at `~/.ava/skills/somethings/SKILL.md` provides:

- Domain glossary (mentees, mentors, mentorships, engagement, billability, etc.)
- Database schema reference (users, mentorships, messages, reporting tables)
- SQL query patterns
- Codebase paths (pointing to `/opt/ava/workspace/repos/`)

## VPC Peering

The Somethings production RDS lives in the old infra VPC (`vpc-0e58d8977c04222fa`, CIDR `10.2.0.0/16`). AVA lives in the new infra-mm production VPC (`vpc-09e54b23038e34e23`, CIDR `10.1.0.0/16`).

VPC peering (`pcx-05fd37580f4853c44`) connects them with:
- Routes in both VPCs' route tables
- CIDR-based SG rule on the Somethings RDS SG (`sg-09a12f12ae207b740`) allowing `10.1.0.0/16` on port 5432

**Note**: SG-to-SG references don't work across VPC peering — must use CIDR-based rules.

## Lessons Learned

1. **`npx tsx` over `node dist/`**: The `@isaacraja/pi-vertex-claude` package ships raw `.ts` files. Node.js 22's native type stripping doesn't work for `node_modules`. Use `npx tsx src/index.ts` as the entrypoint.

2. **URL-encode DB passwords**: RDS auto-generated passwords contain special chars (`}`, `#`, `$`, `]`, etc.). Must be URL-encoded in connection strings. Use `python3 -c "import urllib.parse; print(urllib.parse.quote(password, safe=''))"`.

3. **`sslmode=require&uselibpqcompat=true`**: Required for RDS connections with the `pg` driver. Without `uselibpqcompat=true`, the pg driver treats `sslmode=require` as `verify-full` and fails with "self-signed certificate in certificate chain".

4. **drizzle-kit + ESM**: drizzle-kit's CJS loader can't resolve `.js` extensions in ESM projects. Run via `node --import tsx node_modules/drizzle-kit/bin.cjs push`.

5. **pgvector before db:push**: The `CREATE EXTENSION IF NOT EXISTS vector;` must run before drizzle-kit push, otherwise schema creation fails with "type vector does not exist".

6. **SSM shell PATH**: SSM Session Manager drops into a minimal shell. AWS CLI may not be in PATH. Use `export PATH=$PATH:/usr/local/bin` or find binaries with `which`.

7. **Cross-VPC SG rules**: Security group references (`source_security_group_id`) don't work across VPC peering. Use `cidr_blocks` instead.

8. **RDS SG identification**: When looking up RDS security groups, always check `aws rds describe-db-instances` to see which SG the instance actually uses — there may be multiple similarly-named SGs from different Terraform runs.

9. **Separate Terraform state**: AVA uses its own Terraform root (`ava/`) with a separate state file. This ensures `terraform apply` for AVA can never affect existing infrastructure.

10. **Slack requires valid SSL**: Slack event subscriptions require a valid SSL certificate matching the hostname. The ALB raw DNS won't work because the cert is `*.somethings.com`. DNS CNAME must be set up before Slack integration works.

## Health Checks

```bash
# From anywhere
curl -k https://ava.somethings.com/health

# From EC2
curl http://localhost:3001/health

# Service status
sudo systemctl status ava

# Logs
journalctl -u ava -f
```

## Updating AVA

```bash
sudo su - ubuntu
cd /opt/ava
git pull
pnpm install --frozen-lockfile
sudo systemctl restart ava
journalctl -u ava -f
```
