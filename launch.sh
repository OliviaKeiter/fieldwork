#!/usr/bin/env sh
# Fieldwork launcher (macOS/Linux): ./launch.sh to start the app locally.
# First run installs dependencies and creates app/.env for you to fill in.
set -e
cd "$(dirname "$0")/app"

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies..."
  npm install || {
    echo ""
    echo "npm install failed. Fieldwork needs Node 22.12 or newer - check with: node -v"
    exit 1
  }
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "Created app/.env from the example."
  echo "Open it and fill in your Supabase project URL and anon key"
  echo "(README steps 1-5), then run this launcher again."
  exit 1
fi

echo "Starting Fieldwork at http://localhost:4321 ..."
echo "The server keeps running in the background after Ctrl+C or closing the terminal."
echo "To stop it fully: npx astro dev stop (from the app folder)"
npm run dev -- --open
