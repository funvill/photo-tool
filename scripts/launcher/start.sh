#!/bin/bash
# Start Photobook Studio for the Mac launcher app (or by hand): clear leftover servers, rebuild the
# editor if the code changed, start the server in the background, wait until it answers.
# Prints the editor URL on success; exits non-zero with a message on failure.
#
#   PHOTOBOOK_PORT / PHOTOBOOK_DATA_DIR may be set to run a separate copy (used by tests).
# The editor's data is ./data/photobook-editor when run from source (shared/server/devData.ts); an old
# one-folder ./data layout is split per program first (scripts/carry-over-dev-data.ts).
set -u

PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PHOTOBOOK_PORT:-5174}"
DATA="${PHOTOBOOK_DATA_DIR:-$PROJECT/data/photobook-editor}"
URL="http://127.0.0.1:$PORT"

# Apps opened from Finder get a minimal PATH; find node the way the user's shell would.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  NODE_DIR="$(/bin/zsh -lic 'dirname "$(command -v node)"' 2>/dev/null | tail -1)"
  [ -n "$NODE_DIR" ] && export PATH="$NODE_DIR:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it (e.g. from nodejs.org) and try again." >&2
  exit 1
fi
if [ ! -d "$PROJECT/node_modules" ]; then
  echo "Dependencies are missing. In Terminal, run: cd \"$PROJECT\" && npm install" >&2
  exit 1
fi

# Stop any Photobook server already holding the port (an old `npm start`/`npm run dev`, or a
# previous launch). Only processes running this project's server are touched.
"$PROJECT/scripts/launcher/stop.sh" >/dev/null 2>&1
for pid in $(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  if ps -o command= -p "$pid" | grep -q "photobook-editor/server/main.ts"; then
    kill "$pid" 2>/dev/null
  else
    echo "Port $PORT is in use by another program ($(basename "$(ps -o comm= -p "$pid")")). Close it and try again." >&2
    exit 1
  fi
done
for _ in $(seq 1 20); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done

# With the old servers stopped (nothing has the database open), split an old one-folder ./data per
# program before anything makes ./data/photobook-editor. It is given the caller's own environment: a
# folder chosen by hand is left as it is. On failure it says why.
if ! (cd "$PROJECT" && ./node_modules/.bin/tsx scripts/carry-over-dev-data.ts) >&2; then
  exit 1
fi
mkdir -p "$DATA"
LOG="$DATA/launcher.log"
PIDFILE="$DATA/server-$PORT.pid"

cd "$PROJECT" || exit 1
echo "---- $(date) starting on port $PORT" >> "$LOG"

# Rebuild the editor when any source file is newer than the last build.
BUILT="$PROJECT/dist/photobook-editor/web/index.html"
if [ ! -f "$BUILT" ] || [ -n "$(find photobook-editor shared -newer "$BUILT" -type f -print -quit 2>/dev/null)" ]; then
  echo "building editor" >> "$LOG"
  if ! ./node_modules/.bin/vite build --config photobook-editor/vite.config.ts >> "$LOG" 2>&1; then
    echo "The editor failed to build. Details: $LOG" >&2
    exit 1
  fi
fi

NODE_ENV=production PHOTOBOOK_PORT="$PORT" PHOTOBOOK_DATA_DIR="$DATA" \
  nohup ./node_modules/.bin/tsx photobook-editor/server/main.ts >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"

for _ in $(seq 1 120); do
  if curl -s -m 1 "$URL/api/health" >/dev/null 2>&1; then
    echo "$URL"
    exit 0
  fi
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "The server stopped while starting. Details: $LOG" >&2
    exit 1
  fi
  sleep 0.25
done
echo "The server did not answer within 30 seconds. Details: $LOG" >&2
exit 1
