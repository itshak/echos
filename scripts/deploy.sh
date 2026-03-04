#!/bin/bash
set -euo pipefail

# EchOS deploy script for remote VPS
# Usage: ./scripts/deploy.sh [user@host]

REMOTE="${1:-}"
APP_DIR="/opt/echos"

if [ -z "$REMOTE" ]; then
  echo "Usage: $0 user@host"
  exit 1
fi

echo "Deploying EchOS to $REMOTE..."

# Sync project files
rsync -avz --exclude='node_modules' --exclude='dist' --exclude='data' \
  --exclude='.git' --exclude='.env' \
  ./ "$REMOTE:$APP_DIR/"

# Build and restart on remote
ssh "$REMOTE" bash -s <<'EOF'
  set -euo pipefail
  cd /opt/echos

  # Install pnpm if needed
  command -v pnpm >/dev/null 2>&1 || npm install -g pnpm

  # Install deps and build
  pnpm install --frozen-lockfile
  pnpm build

  # ── UID/GID setup ────────────────────────────────────────────────────────
  # docker-compose uses ${UID}/${GID} so the container writes files as the
  # SSH user — required for SSHFS mounts to be writable.
  # docker/.env is the file docker compose reads for variable substitution
  # (separate from the app .env which is one level up).
  DOCKER_ENV="docker/.env"
  CURRENT_UID=$(id -u)
  CURRENT_GID=$(id -g)

  # Write or refresh UID/GID (preserve any other vars already in docker/.env)
  touch "$DOCKER_ENV"
  grep -v '^UID=' "$DOCKER_ENV" | grep -v '^GID=' > "$DOCKER_ENV.tmp" || true
  printf 'UID=%s\nGID=%s\n' "$CURRENT_UID" "$CURRENT_GID" >> "$DOCKER_ENV.tmp"
  mv "$DOCKER_ENV.tmp" "$DOCKER_ENV"
  echo "Docker user: UID=$CURRENT_UID GID=$CURRENT_GID"

  # Ensure data directories exist and are owned by the current user so
  # Docker (running as the same UID) can write to them.
  mkdir -p data/knowledge data/db data/sessions data/logs
  sudo chown -R "$CURRENT_UID:$CURRENT_GID" data/ 2>/dev/null || \
    chown -R "$CURRENT_UID:$CURRENT_GID" data/ 2>/dev/null || \
    echo "Warning: could not chown data/ — you may need to run: sudo chown -R \$(id -u):\$(id -g) data/"
  # ─────────────────────────────────────────────────────────────────────────

  # Restart via docker-compose
  cd docker
  docker compose down
  docker compose up -d --build

  # Wait for health check
  echo "Waiting for services..."
  sleep 5
  docker compose ps

  echo "Deploy complete!"
EOF
