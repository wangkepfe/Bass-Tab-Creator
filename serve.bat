@echo off
REM ============================================================
REM  Bass Tab Creator - local dev server
REM  Serves the static site over HTTP and opens it in a browser.
REM ============================================================

setlocal
set "PORT=8777"

REM Run from the folder this script lives in, regardless of caller.
cd /d "%~dp0"

REM Find an available Python launcher: prefer the Windows "py" launcher,
REM fall back to "python" on PATH.
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY where python >nul 2>nul && set "PY=python"

if not defined PY (
    echo [ERROR] Python was not found on PATH.
    echo Install Python from https://www.python.org/ and try again.
    pause
    exit /b 1
)

echo Serving Bass Tab Creator at http://localhost:%PORT%/
echo Press Ctrl+C to stop.
echo.

REM Open the default browser, then start the server (blocks until Ctrl+C).
start "" "http://localhost:%PORT%/"
%PY% -m http.server %PORT%

endlocal
