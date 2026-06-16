@echo off
title Studio Tunnel
REM ===========================================================================
REM Exposes the LOCAL backend (http://localhost:8000) to the public internet via
REM an ephemeral Cloudflare Quick Tunnel, so the Cloudflare-Pages frontend can
REM reach this machine. Prints a random https://<words>.trycloudflare.com URL.
REM
REM ORDER OF OPERATIONS:
REM   1. Set the secret + allowed origin in THIS shell (or System env), then run
REM      the backend with start-studio.bat:
REM         set STUDIO_API_TOKEN=<a long random secret>
REM         set STUDIO_ALLOWED_ORIGINS=https://your-project.pages.dev
REM   2. Run this script. Copy the printed https URL.
REM   3. Put that URL (as STUDIO_API_BASE) and the SAME token (STUDIO_TOKEN) into
REM      the Cloudflare Pages build env, then redeploy.
REM
REM The quick-tunnel URL is RANDOM and changes every restart — for a stable URL
REM use a named tunnel with your own domain (see README.md).
REM ===========================================================================

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared is not installed or not on PATH.
  echo Install it:  winget install --id Cloudflare.cloudflared
  pause
  exit /b 1
)

if "%STUDIO_API_TOKEN%"=="" (
  echo.
  echo WARNING: STUDIO_API_TOKEN is not set in this environment. If the backend was
  echo started WITHOUT a token, your machine's project store + yt-dlp + Demucs will
  echo be reachable by anyone who learns this URL. Ctrl+C now and set a token first
  echo unless you really mean to run open.
  echo.
  pause
)

echo Starting Cloudflare Quick Tunnel to http://localhost:8000 ...
echo Copy the printed https://...trycloudflare.com URL into the Pages config (STUDIO_API_BASE).
echo Press Ctrl+C to stop the tunnel.
echo.
cloudflared tunnel --url http://localhost:8000
pause
