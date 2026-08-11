@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title Damuku_music 进程清理
echo ========================================
echo        Damuku_music 进程清理工具
echo ========================================
echo.
echo 当前 8000 端口占用情况：
netstat -ano | findstr ":8000"
echo.
echo 请选择操作：
echo [1] 只结束占用 8000 端口的 Node 进程（推荐）
echo [2] 结束全部 node.exe（会影响其他 Node 项目）
echo [3] 取消
echo.
choice /C 123 /N /M "请输入选项："

if errorlevel 3 goto :cancel
if errorlevel 2 goto :kill_all
if errorlevel 1 goto :kill_port

:kill_port
echo.
echo 正在清理占用 8000 端口的 Node 进程...
set "FOUND_PORT_PROCESS="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do (
    set "FOUND_PORT_PROCESS=1"
    call :kill_pid %%P
)
if not defined FOUND_PORT_PROCESS echo 未发现占用 8000 端口的监听进程。
goto :show_result

:kill_all
echo.
echo 警告：此操作会结束电脑上的全部 node.exe，可能关闭其他项目。
choice /C YN /N /M "确认继续？[Y/N]："
if errorlevel 2 goto :cancel
taskkill /IM node.exe /F /T
goto :show_result

:kill_pid
if "%~1"=="" exit /b 0
tasklist /FI "PID eq %~1" | findstr /I "node.exe" >nul
if errorlevel 1 exit /b 0
echo 正在结束 PID %~1 ...
taskkill /PID %~1 /F /T
exit /b 0

:show_result
echo.
echo 清理后的 Node 进程：
tasklist | findstr /I "node.exe"
if errorlevel 1 echo 未发现正在运行的 node.exe。
echo.
echo 当前 8000 端口占用情况：
netstat -ano | findstr ":8000"
echo.
pause
exit /b 0

:cancel
echo 已取消，不执行任何清理操作。
pause
exit /b 0
