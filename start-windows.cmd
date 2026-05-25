@echo off
setlocal EnableExtensions
title LynLens (dev)
REM =====================================================================
REM  LynLens - one-click run for Windows (developer / dev build).
REM
REM  This script lives in the repo root. After `git clone`, just
REM  double-click it. First run installs deps, downloads ffmpeg/whisper,
REM  builds, and launches; later runs reuse everything and relaunch fast.
REM
REM  Requirements: Node.js (LTS >=20). pnpm is auto-installed via corepack.
REM  Close this console window to quit the app.
REM =====================================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install LTS ^(^>=20^): https://nodejs.org
  goto fail
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [info] enabling pnpm via corepack...
  call corepack enable pnpm
  call corepack prepare pnpm@10.33.0 --activate
)

echo [1/5] installing dependencies...
call pnpm install
if errorlevel 1 goto fail

echo [2/5] building @lynlens/core...
call pnpm --filter @lynlens/core build
if errorlevel 1 goto fail

if not exist "packages\desktop\resources\ffmpeg\win\ffmpeg.exe" (
  echo [3/5] downloading ffmpeg/ffprobe...
  call pnpm bootstrap:ffmpeg
) else (
  echo [3/5] ffmpeg already present, skipping.
)

if not exist "packages\desktop\resources\whisper\win\whisper-cli.exe" (
  echo [4/5] downloading whisper.cpp + model ^(~150MB^)...
  call pnpm bootstrap:whisper
) else (
  echo [4/5] whisper already present, skipping.
)

REM Pre-compile the Electron main process. Without this, the first `pnpm dev`
REM launches Electron before tsc has emitted dist/main and it crashes with an
REM "Error" dialog (Electron only waits on the vite port, not on tsc).
echo [5/5] building Electron main process...
call pnpm --filter @lynlens/desktop build:main
if errorlevel 1 goto fail

echo.
echo [info] launching LynLens... KEEP THIS WINDOW OPEN (closing it quits the app).
echo.
call pnpm --filter @lynlens/desktop dev
goto end

:fail
echo.
echo [FAILED] Setup stopped. Read the messages above to see what went wrong.

:end
echo.
pause
