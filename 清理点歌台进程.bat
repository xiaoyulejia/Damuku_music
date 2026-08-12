@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title Damuku_music service shutdown
echo ========================================
echo        Damuku_music service shutdown
echo ========================================
echo.
echo Detecting this project's Node service...
echo Only app.js, scripts\launch.js and their child processes will be stopped.
echo Other Node projects will not be touched.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-project.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo Damuku_music service stopped.
) else (
    echo Shutdown did not complete. Check the error output above.
)
echo.
pause
exit /b %EXIT_CODE%
