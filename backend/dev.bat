@echo off
cd /d %~dp0

set "DB_CONTAINER=project-origin-db"
set "TMP=%CD%\.tmp"
set "TEMP=%TMP%"
if not exist "%TMP%" mkdir "%TMP%"

REM Ensure Docker is available
docker info >NUL 2>&1
if errorlevel 1 (
  echo [dev] Docker not available. Please start Docker Desktop, or run Postgres locally.
  pause
  exit /b 1
)

REM Ensure Postgres container exists and is running
docker inspect %DB_CONTAINER% >NUL 2>&1
if errorlevel 1 (
  echo [dev] Creating Postgres container "%DB_CONTAINER%"...
  docker run --name %DB_CONTAINER% -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=project_origin -p 5432:5432 -d postgres:16
) else (
  for /f "delims=" %%i in ('docker inspect -f "{{.State.Running}}" %DB_CONTAINER%') do set "DB_RUNNING=%%i"
  if /i not "%DB_RUNNING%"=="true" (
    echo [dev] Starting Postgres container "%DB_CONTAINER%"...
    docker start %DB_CONTAINER% >NUL
  )
)

REM Wait for port 5432 to accept connections (timeout ~20s)
for /l %%i in (1,1,10) do (
  powershell -NoProfile -Command "if (Test-NetConnection -ComputerName 127.0.0.1 -Port 5432 -InformationLevel Quiet) { exit 0 } else { exit 1 }" >NUL
  if not errorlevel 1 goto :DB_READY
  timeout /t 2 /nobreak >NUL
)
echo [dev] Postgres not ready on 127.0.0.1:5432. Please check Docker logs.
pause
exit /b 1

:DB_READY
set "VENV_DIR="
if exist ".venv311\Scripts\python.exe" set "VENV_DIR=.venv311"
if not defined VENV_DIR if exist ".venv\Scripts\python.exe" set "VENV_DIR=.venv"

if not defined VENV_DIR (
  echo [dev] No virtualenv found. Creating .venv311...
  py -3.11 -m venv .venv311 >NUL 2>&1
  if errorlevel 1 (
    python -m venv .venv311
    if errorlevel 1 (
      echo [dev] Failed to create virtualenv. Please install Python 3.11+.
      pause
      exit /b 1
    )
  )
  set "VENV_DIR=.venv311"
)

call %VENV_DIR%\Scripts\activate.bat

python -m pip --version >NUL 2>&1
if errorlevel 1 (
  echo [dev] pip missing in %VENV_DIR%. Repairing...
  python -m ensurepip --upgrade
)

python -c "import sqlalchemy, fastapi" >NUL 2>&1
if errorlevel 1 (
  echo [dev] Installing backend dependencies...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [dev] Dependency install failed.
    pause
    exit /b 1
  )
)

echo [dev] Running database migrations...
python -m alembic upgrade head
if errorlevel 1 (
  echo [dev] Migration failed. Please check DB state.
  pause
  exit /b 1
)

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

pause
