@echo off
title Studio
echo Starting Studio backend (Demucs + basic-pitch + ADTOF + yt-dlp)...
echo.

cd /d "%~dp0bass-studio\server"

if not exist ".venv\Scripts\uvicorn.exe" (
    echo ERROR: venv not found at bass-studio\server\.venv
    echo Run setup first:
    echo   cd bass-studio\server
    echo   python -m venv .venv
    echo   .venv\Scripts\pip install -r requirements.txt   ^&^&  .venv\Scripts\pip install basic-pitch --no-deps yt-dlp
    pause
    exit /b 1
)

echo App:  http://localhost:8000/
echo Press Ctrl+C to stop.
echo.

REM Bind loopback only. cloudflared (start-tunnel.bat) connects to this loopback
REM listener, so there is NO reason to bind 0.0.0.0 / the LAN. Once you expose the
REM backend through a tunnel, the security boundary is NOT the loopback bind any
REM more — it is STUDIO_API_TOKEN + STUDIO_ALLOWED_ORIGINS. Set BOTH before
REM tunnelling, e.g. (in this shell, before running this script):
REM     set STUDIO_API_TOKEN=<a long random secret>
REM     set STUDIO_ALLOWED_ORIGINS=https://your-project.pages.dev
set PYTHONWARNINGS=ignore::FutureWarning
start "" "http://localhost:8000/"
.venv\Scripts\uvicorn.exe app:app --host 127.0.0.1 --port 8000

pause
