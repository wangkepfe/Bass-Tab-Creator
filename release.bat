@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Studio - build release

REM ===========================================================================
REM release.bat - BUILD the portable Desktop release into .\release\
REM
REM Run this from the REPO ROOT, on the DEVELOPER machine that already has the
REM working backend venv at  tab-studio\server\.venv  (it is used ONLY to
REM pre-download the Demucs model weights; it is NOT copied into the release).
REM
REM Produces:
REM   release\
REM     tab-studio\server\   backend (NO .venv, NO __pycache__) + vendored ADTOF weights
REM     tab-studio\web\      the in-browser editor (served at / in desktop mode)
REM     seed-projects\       starter projects (seeded into projects\ on first run)
REM     models\              PRE-DOWNLOADED Demucs htdemucs weights (TORCH_HOME cache)
REM     setup.bat            first-run installer (end user runs ONCE)
REM     run.bat             launcher (end user double-clicks)
REM     README-RELEASE.txt   short end-user instructions
REM
REM The end user therefore never downloads the Demucs model at runtime. ADTOF
REM weights are already vendored in the repo; basic-pitch ships its model inside
REM its pip package (installed by setup.bat). The only things that cannot be
REM bundled are the Python interpreter, the CUDA torch wheels, and ffmpeg --
REM setup.bat installs torch and checks for Python + ffmpeg.
REM
REM NOTE on escaping: setup.bat and run.bat are emitted via "> file (echo ...)"
REM blocks. Inside such a block every ( ) & | < > and % must be escaped (^( ^)
REM ^& ^| ^> ^< and %%). The generated child scripts deliberately use paren-free
REM "if errorlevel N goto :label" error handling to keep this manageable.
REM ===========================================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "REL=%ROOT%\release"
set "DEVPY=%ROOT%\tab-studio\server\.venv\Scripts\python.exe"

echo(
echo === Studio release builder ===
echo Repo root : %ROOT%
echo Output    : %REL%
echo(

REM --- 0) sanity: source tree + dev venv (needed only to fetch model weights) ---
if not exist "%ROOT%\tab-studio\server\app.py" (
  echo ERROR: tab-studio\server\app.py not found. Run this from the repo root.
  goto :fail
)
if not exist "%DEVPY%" (
  echo ERROR: developer venv not found at tab-studio\server\.venv
  echo        Create it first, then re-run release.bat:
  echo          cd tab-studio\server
  echo          python -m venv .venv
  echo          .venv\Scripts\pip install -r requirements.txt
  echo          .venv\Scripts\pip install basic-pitch --no-deps yt-dlp
  goto :fail
)

REM --- 1) clean output dir ----------------------------------------------------
if exist "%REL%" (
  echo Removing previous release folder...
  rmdir /s /q "%REL%"
  if exist "%REL%" (
    echo ERROR: could not delete "%REL%" -- a file may be open / a server running.
    goto :fail
  )
)
mkdir "%REL%" || goto :fail

REM --- 2) copy backend (server) WITHOUT .venv and __pycache__ ------------------
REM    robocopy exit codes 0-7 are success; 8+ is a real failure.
echo Copying backend (tab-studio\server)...
robocopy "%ROOT%\tab-studio\server" "%REL%\tab-studio\server" /E /XD ".venv" "__pycache__" /XF "*.pyc" /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :robofail

REM --- 3) copy the web frontend ----------------------------------------------
echo Copying web frontend (tab-studio\web)...
robocopy "%ROOT%\tab-studio\web" "%REL%\tab-studio\web" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :robofail

REM --- 4) copy the starter projects (seeded into projects\ on first run) -----
echo Copying starter projects...
robocopy "%ROOT%\seed-projects" "%REL%\seed-projects" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :robofail

REM    Pin DESKTOP mode in the shipped config.js. The committed web\config.js
REM    already defaults mode to 'desktop', so this seed is just an explicit
REM    belt-and-suspenders header prepended in front of the normalizer.
> "%REL%\tab-studio\web\config.js" (
  echo window.STUDIO_CONFIG = { mode: "desktop" };
  type "%ROOT%\tab-studio\web\config.js"
)

REM --- 5) PRE-DOWNLOAD Demucs htdemucs weights into release\models -----------
REM    Demucs fetches its weights with torch.hub.load_state_dict_from_url, which
REM    writes into  torch.hub.get_dir()\checkpoints , and torch.hub.get_dir()
REM    returns  %TORCH_HOME%\hub . So pointing TORCH_HOME at release\models makes
REM    the weights land in  release\models\hub\checkpoints  -- exactly where
REM    run.bat re-points TORCH_HOME so the end user never downloads at runtime.
echo(
echo Pre-downloading Demucs "htdemucs" weights into release\models ...
echo (first time on this dev machine -- may take a minute)
mkdir "%REL%\models" 2>nul
set "TORCH_HOME=%REL%\models"
"%DEVPY%" -c "import demucs.pretrained as p; m=p.get_model('htdemucs'); print('htdemucs ready:', type(m).__name__)"
if errorlevel 1 (
  echo ERROR: failed to pre-download the Demucs model with the dev venv.
  goto :fail
)
if not exist "%REL%\models\hub\checkpoints\*" (
  echo ERROR: Demucs weights did not land in release\models\hub\checkpoints
  echo        -- torch.hub layout may have changed. Aborting to avoid shipping a broken cache.
  goto :fail
)
echo Bundled model cache:
dir /b "%REL%\models\hub\checkpoints"

REM --- 6) write setup.bat into release\ --------------------------------------
echo Writing release\setup.bat ...
> "%REL%\setup.bat" (
  echo @echo off
  echo setlocal EnableExtensions
  echo title Studio - first-run setup
  echo(
  echo REM ===================================================================
  echo REM setup.bat - run ONCE. Creates tab-studio\server\.venv and installs
  echo REM all Python deps. Needs internet for pip + the CUDA torch wheels.
  echo REM ===================================================================
  echo set "HERE=%%~dp0"
  echo set "SRV=%%HERE%%tab-studio\server"
  echo set "PY=%%SRV%%\.venv\Scripts\python.exe"
  echo(
  echo REM --- Python on PATH? -------------------------------------------
  echo where python ^>nul 2^>nul
  echo if errorlevel 1 goto :no_python
  echo(
  echo REM --- ffmpeg on PATH? yt-dlp + demucs need it; warn but continue ---
  echo where ffmpeg ^>nul 2^>nul
  echo if not errorlevel 1 goto :ff_ok
  echo echo.
  echo echo WARNING: ffmpeg was not found on PATH. YouTube import and some audio
  echo echo          decoding will FAIL until you install it. Get a build from
  echo echo          https://www.gyan.dev/ffmpeg/builds/ and add its bin folder to PATH.
  echo echo Continuing with the Python setup anyway...
  echo echo.
  echo :ff_ok
  echo(
  echo REM --- create the venv -------------------------------------------
  echo if exist "%%PY%%" goto :have_venv
  echo echo Creating virtual environment...
  echo python -m venv "%%SRV%%\.venv"
  echo if errorlevel 1 goto :venv_fail
  echo :have_venv
  echo(
  echo echo Upgrading pip...
  echo "%%PY%%" -m pip install --upgrade pip
  echo(
  echo echo Installing GPU PyTorch ^(CUDA cu124^) for Demucs...
  echo "%%PY%%" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
  echo if not errorlevel 1 goto :torch_ok
  echo echo.
  echo echo CUDA torch install failed ^(no NVIDIA GPU/driver?^). Falling back to CPU torch...
  echo "%%PY%%" -m pip install torch torchaudio
  echo if errorlevel 1 goto :torch_fail
  echo :torch_ok
  echo(
  echo echo Installing backend requirements...
  echo "%%PY%%" -m pip install -r "%%SRV%%\requirements.txt"
  echo if errorlevel 1 goto :req_fail
  echo(
  echo echo Installing basic-pitch ^(no deps^) and yt-dlp...
  echo "%%PY%%" -m pip install basic-pitch --no-deps yt-dlp
  echo if errorlevel 1 goto :bp_fail
  echo(
  echo echo.
  echo echo === Setup complete. Now double-click run.bat to start the app. ===
  echo pause
  echo exit /b 0
  echo(
  echo :no_python
  echo echo ERROR: Python was not found on PATH.
  echo echo Install Python 3.10-3.12 from https://www.python.org/downloads/
  echo echo and tick "Add python.exe to PATH" during install, then re-run setup.bat.
  echo pause
  echo exit /b 1
  echo :venv_fail
  echo echo ERROR: failed to create the virtual environment.
  echo pause
  echo exit /b 1
  echo :torch_fail
  echo echo ERROR: torch install failed.
  echo pause
  echo exit /b 1
  echo :req_fail
  echo echo ERROR: requirements install failed.
  echo pause
  echo exit /b 1
  echo :bp_fail
  echo echo ERROR: basic-pitch / yt-dlp install failed.
  echo pause
  echo exit /b 1
)

REM --- 7) write run.bat into release\ ----------------------------------------
echo Writing release\run.bat ...
> "%REL%\run.bat" (
  echo @echo off
  echo setlocal EnableExtensions
  echo title Studio
  echo(
  echo REM ===================================================================
  echo REM run.bat - launch the local Studio app. Binds to 127.0.0.1 ONLY:
  echo REM no network exposure, no auth/token, no tunnel. Opens your browser.
  echo REM ===================================================================
  echo set "HERE=%%~dp0"
  echo set "SRV=%%HERE%%tab-studio\server"
  echo set "PY=%%SRV%%\.venv\Scripts\python.exe"
  echo(
  echo if exist "%%PY%%" goto :have_py
  echo echo ERROR: dependencies not installed yet.
  echo echo Double-click setup.bat first ^(one time^), then run.bat.
  echo pause
  echo exit /b 1
  echo :have_py
  echo(
  echo REM Point the model caches at the BUNDLED weights so nothing downloads.
  echo REM TORCH_HOME drives torch.hub: Demucs reads its htdemucs weights from
  echo REM %%TORCH_HOME%%\hub\checkpoints  ^(this folder's models\hub\checkpoints^).
  echo set "TORCH_HOME=%%HERE%%models"
  echo set "HF_HOME=%%HERE%%models\huggingface"
  echo set "XDG_CACHE_HOME=%%HERE%%models\cache"
  echo set "PYTHONWARNINGS=ignore::FutureWarning"
  echo(
  echo where ffmpeg ^>nul 2^>nul
  echo if errorlevel 1 echo NOTE: ffmpeg not on PATH - YouTube import/decoding may fail. See README-RELEASE.txt.
  echo(
  echo echo Starting Studio on http://127.0.0.1:8000/   ^(press Ctrl+C to stop^)
  echo start "" "http://127.0.0.1:8000/"
  echo "%%PY%%" -m uvicorn app:app --app-dir "%%SRV%%" --host 127.0.0.1 --port 8000
  echo(
  echo echo Server stopped.
  echo pause
)

REM --- 8) short end-user readme ----------------------------------------------
echo Writing release\README-RELEASE.txt ...
> "%REL%\README-RELEASE.txt" (
  echo Studio - local AI desktop app
  echo =============================
  echo(
  echo Requirements -- install these first if missing:
  echo   * Python 3.10 - 3.12   https://www.python.org/downloads/   tick "Add to PATH"
  echo   * ffmpeg               https://www.gyan.dev/ffmpeg/builds/   add its bin folder to PATH
  echo   * An NVIDIA GPU is recommended ^(CUDA^); it falls back to CPU but is slow.
  echo(
  echo First run:
  echo   1. Double-click  setup.bat   one time; creates .venv and installs deps
  echo   2. Double-click  run.bat     starts the app and opens your browser
  echo(
  echo The app runs entirely on your machine at http://127.0.0.1:8000/ -- nothing
  echo is uploaded anywhere. Saved projects live in this folder under projects\.
)

REM --- 9) optional zip --------------------------------------------------------
echo(
echo Zipping release\ -^> studio-release.zip ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%REL%\*' -DestinationPath '%ROOT%\studio-release.zip' -Force" 2>nul
if exist "%ROOT%\studio-release.zip" (
  echo Created studio-release.zip
) else (
  echo NOTE: zip step skipped/failed -- the release\ folder itself is complete.
)

echo(
echo === DONE. Ship the release\ folder or studio-release.zip. ===
echo End user: run setup.bat once, then run.bat.
endlocal
exit /b 0

REM ===========================================================================
REM error exits
REM ===========================================================================
:robofail
echo ERROR: robocopy reported a copy failure (exit %errorlevel%).
:fail
echo(
echo BUILD FAILED.
endlocal
exit /b 1
