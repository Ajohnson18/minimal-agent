#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TF_DIR="$ROOT_DIR/kai-skeleton"

# ── Usage ────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: ./deploy.sh <command> [options]

Infrastructure:
  init   <client-env>          Terraform init with backend config
  plan   <client-env>          Plan infrastructure changes
  apply  <client-env>          Apply infrastructure (default auto-approve)
  destroy <client-env>         Destroy infrastructure

Deployment:
  redeploy <client-env>        Force new ECS deployment (pull latest images)
  status   <client-env>        Show service status
  logs          <client-env> [svc]  Tail logs (brain|face, default: brain)

Images:
  build [version]              Build kai-brain and kai-face images
  push  [version]              Push images to ghcr.io
  build-push [version]         Build and push (default version: latest)

Examples:
  ./deploy.sh build-push 0.0.2
  ./deploy.sh apply somethings-production
  ./deploy.sh redeploy somethings-production
  ./deploy.sh logs somethings-production face
EOF
  exit 1
}

[[ $# -lt 1 ]] && usage

CMD="$1"; shift

# ── Image helpers ────────────────────────────────────────────
REGISTRY="ghcr.io/clx-labs"
PLATFORM="linux/amd64"

build_images() {
  local version="${1:-latest}"
  echo "Building kai-brain and kai-face ($version) for $PLATFORM ..."

  docker build --platform "$PLATFORM" \
    -t "$REGISTRY/kai-brain:$version" \
    "$ROOT_DIR/kai-brain"

  docker build --platform "$PLATFORM" \
    -t "$REGISTRY/kai-face:$version" \
    "$ROOT_DIR/kai-face"

  echo "✅ Built: $REGISTRY/kai-brain:$version"
  echo "✅ Built: $REGISTRY/kai-face:$version"
}

push_images() {
  local version="${1:-latest}"
  echo "Pushing kai-brain and kai-face ($version) ..."

  docker push "$REGISTRY/kai-brain:$version"
  docker push "$REGISTRY/kai-face:$version"

  echo "✅ Pushed: $REGISTRY/kai-brain:$version"
  echo "✅ Pushed: $REGISTRY/kai-face:$version"
}

# ── Infra helpers ────────────────────────────────────────────
resolve_client() {
  local client_env="$1"
  TFVARS="$TF_DIR/env/${client_env}.tfvars"
  BACKEND="$TF_DIR/env/${client_env}.backend.hcl"

  if [[ ! -f "$TFVARS" ]]; then
    echo "❌ Missing: $TFVARS"
    exit 1
  fi

  CUSTOMER=$(grep '^customer' "$TFVARS" | sed 's/.*=.*"\(.*\)".*/\1/')
  ENV=$(grep '^env ' "$TFVARS" | sed 's/.*=.*"\(.*\)".*/\1/')
  REGION=$(grep '^aws_region' "$TFVARS" | sed 's/.*=.*"\(.*\)".*/\1/' 2>/dev/null || echo "us-east-1")
  CLUSTER="kai-${CUSTOMER}-${ENV}"

  echo "══════════════════════════════════════════════════"
  echo "  Kai: ${CUSTOMER} / ${ENV}"
  echo "  Cluster: ${CLUSTER}  Region: ${REGION}"
  echo "══════════════════════════════════════════════════"
}

# ── Commands ─────────────────────────────────────────────────
case "$CMD" in

  # ── Images ───────────────────────────────────────────
  build)
    build_images "${1:-latest}"
    ;;

  push)
    push_images "${1:-latest}"
    ;;

  build-push)
    local_ver="${1:-latest}"
    build_images "$local_ver"
    push_images "$local_ver"
    ;;

  # ── Terraform ────────────────────────────────────────
  init)
    [[ $# -lt 1 ]] && usage
    resolve_client "$1"
    if [[ ! -f "$BACKEND" ]]; then
      echo "❌ Missing: $BACKEND"
      exit 1
    fi
    cd "$TF_DIR"
    terraform init -backend-config="$BACKEND" -reconfigure
    ;;

  plan)
    [[ $# -lt 1 ]] && usage
    resolve_client "$1"
    cd "$TF_DIR"
    terraform plan -var-file="$TFVARS" -out="/tmp/${1}.tfplan"
    echo "✅ Plan saved. Run: ./deploy.sh apply $1"
    ;;

  apply)
    [[ $# -lt 1 ]] && usage
    resolve_client "$1"
    cd "$TF_DIR"
    if [[ -f "/tmp/${1}.tfplan" ]]; then
      terraform apply "/tmp/${1}.tfplan"
      rm -f "/tmp/${1}.tfplan"
    else
      terraform apply -var-file="$TFVARS" -auto-approve
    fi
    echo ""
    echo "✅ Applied. Force image update: ./deploy.sh redeploy $1"
    ;;

  destroy)
    [[ $# -lt 1 ]] && usage
    resolve_client "$1"
    echo "⚠️  This will DESTROY all Kai infra for ${CUSTOMER}/${ENV}"
    read -p "Type '$1' to confirm: " CONFIRM
    [[ "$CONFIRM" != "$1" ]] && echo "Aborted." && exit 1
    cd "$TF_DIR"
    terraform destroy -var-file="$TFVARS" -auto-approve
    ;;

  # ── ECS operations ───────────────────────────────────
  redeploy)
    [[ $# -lt 1 ]] && usage
    resolve_client "$1"
    echo "Forcing new deployment ..."
    for svc in kai-brain kai-face; do
      aws ecs update-service \
        --cluster "$CLUSTER" --service "$svc" \
        --force-new-deployment --region "$REGION" \
        --no-cli-pager --output text > /dev/null
      echo "  ↻ $svc"
    done
    echo "✅ Triggered. Monitor: ./deploy.sh status $1"
    ;;

  status)
    [[ $# -lt 1 ]] && usage
    resolve_client "$1"
    aws ecs describe-services \
      --cluster "$CLUSTER" --services kai-brain kai-face \
      --region "$REGION" \
      --query 'services[*].{Service:serviceName,Status:status,Desired:desiredCount,Running:runningCount,Pending:pendingCount}' \
      --output table
    ;;

  logs)
    [[ $# -lt 1 ]] && usage
    resolve_client "$1"
    SVC="${2:-brain}"
    echo "Tailing /ecs/${CLUSTER}-${SVC} ..."
    aws logs tail "/ecs/${CLUSTER}-${SVC}" --follow --region "$REGION"
    ;;

  *)
    echo "❌ Unknown command: $CMD"
    usage
    ;;
esac
