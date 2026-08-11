@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title Damuku_music 服务关闭
echo ========================================
echo        Damuku_music 服务关闭工具
echo ========================================
echo.
echo 正在识别本项目的 Node 服务……
echo 只会结束当前项目目录下的 app.js / scripts\launch.js 及其子进程。
echo 不会结束其他 Node 项目。
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-project.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo Damuku_music 服务已关闭。
) else (
    echo 服务关闭未完全成功，请以管理员身份重新运行此脚本，或检查上面的错误信息。
)
echo.
pause
exit /b %EXIT_CODE%
