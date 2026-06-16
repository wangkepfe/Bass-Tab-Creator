@echo off
title Studio
echo Starting Studio backend (Demucs + basic-pitch + ADTLib + yt-dlp)...
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

REM Bind loopback only — the project API is unauthenticated and now persists
REM your songs/stems/projects to disk; do NOT expose it to the LAN.
set PYTHONWARNINGS=ignore::FutureWarning
start "" "http://localhost:8000/"
.venv\Scripts\uvicorn.exe app:app --host 127.0.0.1 --port 8000

pause
