@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Studio - build web release

REM ===========================================================================
REM release-web.bat - BUILD the static WEB site into .\dist\ and zip it.
REM
REM Run from the REPO ROOT. Needs Node >= 18 on PATH (build.js is zero-dep).
REM
REM The web build is the OFFLINE editor + bundled starter projects: full in-browser
REM editor, config.js forced to mode='web', NO backend (no AI; projects persist as
REM local .studio.json files). build.js does the assembly; this script just runs it
REM and packages the result.
REM
REM Produces:
REM   dist\               static site (index.html at root) - deploy this
REM   studio-web.zip      the same dist\ contents zipped at the root
REM
REM Deploy: upload dist\ to any static host, or `npx wrangler deploy`
REM (wrangler.jsonc runs `node build.js` and serves ./dist as Workers assets).
REM ===========================================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "OUT=%ROOT%\dist"
set "ZIP=%ROOT%\studio-web.zip"

echo(
echo === Studio web release builder ===
echo Repo root : %ROOT%
echo Output    : %OUT%
echo(

REM --- 0) sanity: Node on PATH + build.js present ----------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found on PATH.
  echo Install Node 18+ from https://nodejs.org/ then re-run release-web.bat.
  goto :fail
)
if not exist "%ROOT%\build.js" (
  echo ERROR: build.js not found. Run this from the repo root.
  goto :fail
)

REM --- 1) build dist\ --------------------------------------------------------
echo Building dist\ (node build.js)...
node "%ROOT%\build.js"
if errorlevel 1 goto :fail
if not exist "%OUT%\index.html" (
  echo ERROR: dist\index.html missing after build -- build did not complete.
  goto :fail
)

REM --- 2) zip dist\ -> studio-web.zip ----------------------------------------
echo(
echo Zipping dist\ -^> studio-web.zip ...
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%OUT%\*' -DestinationPath '%ZIP%' -Force"
if not exist "%ZIP%" (
  echo ERROR: failed to create studio-web.zip.
  goto :fail
)

echo(
echo === DONE. Static site in dist\  ^|  zipped to studio-web.zip ===
echo Upload dist\ to any static host, or run: npx wrangler deploy
endlocal
exit /b 0

REM ===========================================================================
:fail
echo(
echo WEB BUILD FAILED.
endlocal
exit /b 1
