#!/bin/bash
# Sandbox Diagnostic Script
# Run this to verify sandbox configuration and health

set -e

echo "🔍 AVA Sandbox Diagnostic"
echo "========================="
echo ""

# Check Docker
echo "1️⃣  Checking Docker..."
if ! docker info &>/dev/null; then
    echo "   ❌ Docker is not running or not accessible"
    exit 1
fi
echo "   ✅ Docker is running"
echo ""

# Check sandbox image
echo "2️⃣  Checking sandbox image..."
if docker images | grep -q "ava-sandbox-exec"; then
    echo "   ✅ ava-sandbox-exec image exists"
    docker images | grep "ava-sandbox-exec" | head -1
else
    echo "   ⚠️  ava-sandbox-exec image not found"
    echo "   Run: docker build -t ava-sandbox-exec -f Dockerfile.sandbox-exec ."
fi
echo ""

# Check running containers
echo "3️⃣  Checking running sandbox containers..."
CONTAINERS=$(docker ps --filter "name=ava-sandbox-" --format "{{.Names}}" | wc -l | tr -d ' ')
if [ "$CONTAINERS" -gt 0 ]; then
    echo "   ✅ Found $CONTAINERS running sandbox container(s):"
    docker ps --filter "name=ava-sandbox-" --format "   - {{.Names}} ({{.Status}})"
else
    echo "   ℹ️  No sandbox containers running (will be created on first use)"
fi
echo ""

# Check workspace directory
echo "4️⃣  Checking workspace directories..."
if [ -d ".sandbox" ]; then
    echo "   ✅ .sandbox directory exists"
    WORKSPACES=$(find .sandbox -type d -name "workspace" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$WORKSPACES" -gt 0 ]; then
        echo "   ✅ Found $WORKSPACES workspace(s):"
        find .sandbox -type d -name "workspace" 2>/dev/null | while read ws; do
            FILES=$(find "$ws" -type f 2>/dev/null | wc -l | tr -d ' ')
            echo "   - $ws ($FILES files)"
        done
    else
        echo "   ℹ️  No workspaces created yet"
    fi
else
    echo "   ℹ️  .sandbox directory doesn't exist (will be created on first use)"
fi
echo ""

# Check config
echo "5️⃣  Checking configuration..."
if [ -f "config.json" ]; then
    echo "   ✅ config.json exists"
    if grep -q '"sandbox"' config.json 2>/dev/null; then
        MODE=$(grep -A10 '"sandbox"' config.json | grep '"mode"' | cut -d'"' -f4 || echo "not found")
        SCOPE=$(grep -A10 '"sandbox"' config.json | grep '"scope"' | cut -d'"' -f4 || echo "not found")
        NETWORK=$(grep -A10 '"sandbox"' config.json | grep '"network"' | cut -d'"' -f4 || echo "not found")
        echo "   Mode: $MODE"
        echo "   Scope: $SCOPE"
        echo "   Network: $NETWORK"
    else
        echo "   ⚠️  No sandbox config found, using defaults"
    fi
else
    echo "   ℹ️  No config.json, checking environment variables..."
    echo "   SANDBOX_MODE: ${SANDBOX_MODE:-not set (default: off)}"
    echo "   SANDBOX_SCOPE: ${SANDBOX_SCOPE:-not set (default: user)}"
    echo "   SANDBOX_NETWORK: ${SANDBOX_NETWORK:-not set (default: none)}"
fi
echo ""

# Test container security if one is running
if [ "$CONTAINERS" -gt 0 ]; then
    echo "6️⃣  Checking container security..."
    CONTAINER_ID=$(docker ps --filter "name=ava-sandbox-" --format "{{.ID}}" | head -1)

    # Check read-only root
    READONLY=$(docker inspect "$CONTAINER_ID" | jq -r '.[0].HostConfig.ReadonlyRootfs')
    if [ "$READONLY" = "true" ]; then
        echo "   ✅ Filesystem is read-only"
    else
        echo "   ⚠️  Filesystem is writable (security risk)"
    fi

    # Check capabilities
    CAPS=$(docker inspect "$CONTAINER_ID" | jq -r '.[0].HostConfig.CapDrop[]' 2>/dev/null)
    if echo "$CAPS" | grep -q "ALL"; then
        echo "   ✅ All capabilities dropped"
    else
        echo "   ⚠️  Not all capabilities dropped"
    fi

    # Check network
    NET_MODE=$(docker inspect "$CONTAINER_ID" | jq -r '.[0].HostConfig.NetworkMode')
    echo "   Network mode: $NET_MODE"

    # Check user
    USER=$(docker exec "$CONTAINER_ID" whoami 2>/dev/null || echo "error")
    if [ "$USER" = "sandbox" ]; then
        echo "   ✅ Running as 'sandbox' user"
    else
        echo "   ⚠️  Running as '$USER' (expected 'sandbox')"
    fi

    # Check workspace
    WS_EXISTS=$(docker exec "$CONTAINER_ID" test -d /workspace && echo "yes" || echo "no")
    if [ "$WS_EXISTS" = "yes" ]; then
        echo "   ✅ /workspace directory exists"
        WS_WRITABLE=$(docker exec "$CONTAINER_ID" test -w /workspace && echo "yes" || echo "no")
        if [ "$WS_WRITABLE" = "yes" ]; then
            echo "   ✅ /workspace is writable"
        else
            echo "   ❌ /workspace is not writable"
        fi
    else
        echo "   ❌ /workspace directory missing"
    fi
else
    echo "6️⃣  Skipping security checks (no containers running)"
fi
echo ""

# Summary
echo "📊 Summary"
echo "=========="
if docker info &>/dev/null && docker images | grep -q "ava-sandbox-exec"; then
    echo "✅ Sandbox ready to use"
    echo ""
    echo "Next steps:"
    echo "1. Enable sandbox in config: SANDBOX_MODE=all or edit config.json"
    echo "2. Restart AVA"
    echo "3. Test in Slack: 'write a file test.txt then read it back'"
else
    echo "⚠️  Sandbox not fully configured"
    echo ""
    echo "To set up:"
    echo "1. docker build -t ava-sandbox-exec -f Dockerfile.sandbox-exec ."
    echo "2. export SANDBOX_MODE=all"
    echo "3. Restart AVA"
fi
echo ""
