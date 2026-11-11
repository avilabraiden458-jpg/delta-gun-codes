@echo off
rem Delta Force - Gun Build Codes Workbench (windowless launcher)
cd /d "%~dp0"

where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw.exe server.py
  exit /b 0
)

where python >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "python server.py"
  exit /b 0
)

where py >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "py server.py"
  exit /b 0
)

echo [ERROR] Python not found. Install Python 3 from python.org
echo         and check "Add python.exe to PATH" during setup.
pause
