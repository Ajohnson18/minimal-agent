#!/usr/bin/env bash
# Browser Sandbox Entrypoint
# Launches Xvfb + Chromium with CDP for browser automation
set -euo pipefail

# Display and home configuration
export DISPLAY=:1
export HOME=/tmp/browser-home
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

# Port configuration (can be overridden via environment)
CDP_PORT="${BROWSER_CDP_PORT:-9222}"
VNC_PORT="${BROWSER_VNC_PORT:-5900}"
NOVNC_PORT="${BROWSER_NOVNC_PORT:-6080}"
ENABLE_NOVNC="${BROWSER_ENABLE_NOVNC:-1}"
HEADLESS="${BROWSER_HEADLESS:-0}"
DEFAULT_XVFB_WIDTH=1920
DEFAULT_XVFB_HEIGHT=1080
DEFAULT_XVFB_DEPTH=24

normalize_positive_int() {
    local raw="$1"
    local fallback="$2"
    if [[ "${raw}" =~ ^[1-9][0-9]*$ ]]; then
        echo "${raw}"
    else
        echo "${fallback}"
    fi
}

XVFB_WIDTH="$(normalize_positive_int "${BROWSER_XVFB_WIDTH:-${DEFAULT_XVFB_WIDTH}}" "${DEFAULT_XVFB_WIDTH}")"
XVFB_HEIGHT="$(normalize_positive_int "${BROWSER_XVFB_HEIGHT:-${DEFAULT_XVFB_HEIGHT}}" "${DEFAULT_XVFB_HEIGHT}")"
XVFB_DEPTH="$(normalize_positive_int "${BROWSER_XVFB_DEPTH:-${DEFAULT_XVFB_DEPTH}}" "${DEFAULT_XVFB_DEPTH}")"
WINDOW_WIDTH="$(normalize_positive_int "${BROWSER_WINDOW_WIDTH:-${XVFB_WIDTH}}" "${XVFB_WIDTH}")"
WINDOW_HEIGHT="$(normalize_positive_int "${BROWSER_WINDOW_HEIGHT:-${XVFB_HEIGHT}}" "${XVFB_HEIGHT}")"

# Create required directories
mkdir -p "${HOME}" "${HOME}/.chrome" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"

# Clean stale locks from previous runs
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
rm -f "${HOME}/.chrome/SingletonLock" "${HOME}/.chrome/SingletonSocket" "${HOME}/.chrome/SingletonCookie"

echo "Starting Xvfb on display :1 (${XVFB_WIDTH}x${XVFB_HEIGHT}x${XVFB_DEPTH})..."
Xvfb :1 -screen 0 "${XVFB_WIDTH}x${XVFB_HEIGHT}x${XVFB_DEPTH}" -ac -nolisten tcp &
sleep 1

# Chrome arguments
if [[ "${HEADLESS}" == "1" ]]; then
    CHROME_ARGS=(
        "--headless=new"
        "--disable-gpu"
    )
else
    CHROME_ARGS=()
fi

# Use internal port for Chrome, socat will proxy to external port
if [[ "${CDP_PORT}" -ge 65535 ]]; then
    CHROME_CDP_PORT="$((CDP_PORT - 1))"
else
    CHROME_CDP_PORT="$((CDP_PORT + 1))"
fi

CHROME_ARGS+=(
    "--remote-debugging-address=127.0.0.1"
    "--remote-debugging-port=${CHROME_CDP_PORT}"
    "--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}"
    "--user-data-dir=${HOME}/.chrome"
    "--no-first-run"
    "--no-default-browser-check"
    "--disable-dev-shm-usage"
    "--disable-background-networking"
    "--disable-features=TranslateUI"
    "--disable-breakpad"
    "--disable-crash-reporter"
    "--metrics-recording-only"
    "--no-sandbox"
    "--disable-setuid-sandbox"
    "--disable-blink-features=AutomationControlled"
)

echo "Starting Chromium with CDP on port ${CHROME_CDP_PORT}..."
chromium "${CHROME_ARGS[@]}" about:blank &

# Wait for Chrome to be ready
echo "Waiting for Chrome CDP to be ready..."
for _ in $(seq 1 50); do
    if curl -sS --max-time 1 "http://127.0.0.1:${CHROME_CDP_PORT}/json/version" >/dev/null 2>&1; then
        echo "Chrome CDP is ready!"
        break
    fi
    sleep 0.1
done

# Proxy CDP port to allow external connections
echo "Starting socat proxy on port ${CDP_PORT}..."
socat \
    TCP-LISTEN:"${CDP_PORT}",fork,reuseaddr,bind=0.0.0.0 \
    TCP:127.0.0.1:"${CHROME_CDP_PORT}" &

# Optional: Start VNC and noVNC for debugging
if [[ "${ENABLE_NOVNC}" == "1" && "${HEADLESS}" != "1" ]]; then
    echo "Starting VNC on port ${VNC_PORT}..."
    x11vnc -display :1 -rfbport "${VNC_PORT}" -shared -forever -nopw -localhost &
    
    echo "Starting noVNC on port ${NOVNC_PORT}..."
    websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
fi

echo "Browser sandbox ready!"
echo "  CDP: http://0.0.0.0:${CDP_PORT}"
if [[ "${ENABLE_NOVNC}" == "1" && "${HEADLESS}" != "1" ]]; then
    echo "  noVNC: http://localhost:${NOVNC_PORT}/vnc.html"
fi

# Wait for any process to exit
wait -n
