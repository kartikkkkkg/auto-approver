@echo off
REM Always start in the folder where this BAT file lives
cd /d %~dp0

echo ================================
echo  WFM Auto Approver
echo  Working folder: %CD%
echo ================================
echo.

echo Checking Node.js...
node -v
if ERRORLEVEL 1 (
  echo.
  echo ERROR: Node.js is not available when running from this BAT.
  echo Try running manually from a command prompt:
  echo     node approve.js requests.csv
  echo.
  echo Or ask IT to add Node.js to your PATH.
  echo.
  pause
  exit /b 1
)

echo.
echo Running: node approve.js requests.csv
echo.

node approve.js requests.csv

echo.
echo Script finished with exit code %ERRORLEVEL%.
echo (If something failed, scroll up to see the error message.)
echo.
pause
