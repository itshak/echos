#!/bin/sh
# EchOS Docker entrypoint
# Runs as root, fixes data directory ownership, then drops to the target user.
# This handles host volume ownership mismatches (e.g. files created by a
# previous container or setup process as a different UID).

set -e

# The user/group the app will run as (matches the node user in the image)
APP_USER="${APP_USER:-node}"
APP_UID=$(id -u "$APP_USER" 2>/dev/null || echo 1000)
APP_GID=$(id -g "$APP_USER" 2>/dev/null || echo 1000)

# Fix ownership of data directories if they are not already owned by the app user.
# This is a no-op when ownership is already correct, so it's fast on normal starts.
for dir in /app/data/knowledge /app/data/db /app/data/sessions /app/data/logs; do
  if [ -d "$dir" ]; then
    dir_owner=$(stat -c '%u' "$dir" 2>/dev/null || stat -f '%u' "$dir" 2>/dev/null || echo "$APP_UID")
    if [ "$dir_owner" != "$APP_UID" ]; then
      echo "entrypoint: fixing ownership of $dir ($dir_owner -> $APP_UID)"
      chown -R "$APP_UID:$APP_GID" "$dir"
    fi
  fi
done

# Drop to the app user and exec the main process
exec su-exec "$APP_USER" "$@"
