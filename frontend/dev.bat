@echo off
cd /d %~dp0

if not exist node_modules\.bin\vite.cmd (
  echo [dev] Installing frontend deps...
  npm install
)

npm run dev
