@echo off
title Studio
echo.

REM --- 1) rebuild from the repo root (needs Node >= 18 on PATH) --------------
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo WARNING: Node not found on PATH - skipping rebuild ^(seed-projects\ and dist\ left as-is^).
) else (
    echo Regenerating starter projects ^(build-seeds.js^)...
    node tab-studio\tools\build-seeds.js
    if errorlevel 1 echo WARNING: build-seeds.js failed - using existing seed-projects.
    echo Building the static web app ^(build.js -^> dist\^)...
    node build.js
    if errorlevel 1 echo WARNING: build.js failed - dist\ may be stale.
)
echo.

REM --- 2) start the local backend -------------------------------------------
echo Starting Studio backend (Demucs + basic-pitch + ADTOF + yt-dlp)...
cd /d "%~dp0tab-studio\server"

if not exist ".venv\Scripts\python.exe" (
    echo ERROR: venv not found at tab-studio\server\.venv
    echo Run setup first:
    echo   cd tab-studio\server
    echo   python -m venv .venv
    echo   .venv\Scripts\pip install -r requirements.txt   ^&^&  .venv\Scripts\pip install basic-pitch --no-deps yt-dlp
    pause
    exit /b 1
)

echo App:  http://localhost:8000/
echo Press Ctrl+C to stop.
echo.

REM Dev launcher for the local backend. Binds 127.0.0.1 only (local app, no network
REM exposure). For an end-user release use release.bat -> run.bat instead.
set PYTHONWARNINGS=ignore::FutureWarning
start "" "http://localhost:8000/"
.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000

pause
