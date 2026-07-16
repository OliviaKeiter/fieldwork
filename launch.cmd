@echo off
setlocal
REM Fieldwork launcher (Windows): double-click to start the app locally.
REM First run installs dependencies and creates app\.env for you to fill in.
cd /d "%~dp0app"

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Fieldwork needs Node 22.12 or newer - check with: node -v
    pause
    exit /b 1
  )
)

if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Created app\.env from the example.
  echo Open it and fill in your Supabase project URL and anon key
  echo ^(README steps 1-5^), then double-click this launcher again.
  pause
  exit /b 1
)

echo Starting Fieldwork at http://localhost:4321 ...
echo The server keeps running in the background even after this window closes.
echo To stop it fully: open a terminal in the app folder and run  npx astro dev stop
call npm run dev -- --open
pause
