@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "NODE_MIN_MAJOR=18"
set "NODE_DOWNLOAD_URL=https://nodejs.org/en/download/"
set "NPM_MIRROR=https://registry.npmmirror.com"
set "NPM_OFFICIAL=https://registry.npmjs.org"

echo ========================================
echo        Damuku_music 点歌台启动器
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    goto :node_missing
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto :node_missing
if !NODE_MAJOR! LSS !NODE_MIN_MAJOR! goto :node_old

where npm >nul 2>nul
if errorlevel 1 goto :npm_missing

echo 已检测到 Node.js !NODE_MAJOR! 和 npm。
if not exist "node_modules\express\package.json" (
    echo 首次运行，使用国内镜像安装依赖：%NPM_MIRROR%
    call npm.cmd install --registry=%NPM_MIRROR%
    if errorlevel 1 (
        echo 国内镜像安装失败，正在切换 npm 官方源重试...
        call npm.cmd install --registry=%NPM_OFFICIAL%
        if errorlevel 1 goto :install_failed
    )
)

echo.
echo 正在启动点歌台服务；如果服务已经运行，启动器会直接复用它。
call npm.cmd run launch
set "EXIT_CODE=!ERRORLEVEL!"
if not "!EXIT_CODE!"=="0" (
    echo.
    echo 点歌台启动失败，退出码：!EXIT_CODE!
    pause
)
exit /b !EXIT_CODE!

:node_missing
echo 未检测到 Node.js。
echo 请安装 Node.js 24 LTS（推荐），至少需要 Node.js 18。
echo 即将打开官方下载页面：%NODE_DOWNLOAD_URL%
start "" "%NODE_DOWNLOAD_URL%"
pause
exit /b 1

:node_old
echo 当前 Node.js 主版本为 %NODE_MAJOR%，项目至少需要 Node.js %NODE_MIN_MAJOR%。
echo 推荐安装 Node.js 24 LTS，官方下载页面：%NODE_DOWNLOAD_URL%
start "" "%NODE_DOWNLOAD_URL%"
pause
exit /b 1

:npm_missing
echo 已检测到 Node.js，但没有检测到 npm。
echo 请重新安装 Node.js 24 LTS，并确保安装时启用 npm 和加入 PATH。
start "" "%NODE_DOWNLOAD_URL%"
pause
exit /b 1

:install_failed
echo 依赖安装失败，请检查网络或 npm 错误信息后重试。
pause
exit /b 1
