@echo off
chcp 65001 >nul
title Dungeon Survival - Web Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js ^(https://nodejs.org^), or serve "build/web-mobile"
  echo         with any static HTTP server.
  echo.
  pause
  exit /b 1
)

echo Starting local server for Dungeon Survival (web build)...
echo The browser will open automatically. Close this window to stop.
echo.
node "%~dp0launcher_web.js"
pause
