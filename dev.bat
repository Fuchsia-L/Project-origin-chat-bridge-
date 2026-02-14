@echo off
cd /d %~dp0

REM Start backend (includes Docker Postgres bootstrap)
start "project-origin-backend" cmd /k "cd /d backend && call dev.bat"

REM Start frontend (install deps if missing)
start "project-origin-frontend" cmd /k "cd /d frontend && call dev.bat"

echo [dev] Backend and frontend started in separate windows.
