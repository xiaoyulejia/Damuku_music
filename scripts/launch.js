const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { loadRuntimeConfig } = require('../src/config');

const rootDir = path.resolve(__dirname, '..');
const runtime = loadRuntimeConfig(rootDir);
const port = runtime.port;
const basePath = runtime.basePath || '';
const launcherPath = `${basePath.replace(/\/$/, '')}/launcher.html`;
const launcherUrl = `http://localhost:${port}${launcherPath}?server_version=${encodeURIComponent(runtime.buildId)}`;
let appProcess = null;

function probe() {
    return new Promise(resolve => {
        const request = http.get(`http://127.0.0.1:${port}${launcherPath}`, response => {
            response.resume();
            resolve(response.statusCode >= 200 && response.statusCode < 400);
        });
        request.setTimeout(800, () => {
            request.destroy();
            resolve(false);
        });
        request.on('error', () => resolve(false));
    });
}

function openBrowser() {
    const command = process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/c', 'start', '', launcherUrl]]
        : process.platform === 'darwin'
            ? ['open', [launcherUrl]]
            : ['xdg-open', [launcherUrl]];
    const browser = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
    browser.unref();
}

async function waitForServer() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await probe()) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

async function main() {
    if (await probe()) {
        console.log(`检测到已有服务，正在打开：${launcherUrl}`);
        openBrowser();
        return;
    }

    appProcess = spawn(process.execPath, [path.join(rootDir, 'app.js')], {
        cwd: rootDir,
        stdio: 'inherit',
        windowsHide: false,
    });
    appProcess.on('exit', code => process.exit(code ?? 0));

    if (await waitForServer()) {
        console.log(`点歌台已启动，正在打开：${launcherUrl}`);
        openBrowser();
        console.log('请在浏览器中输入房间号；关闭此窗口将停止本次启动的服务。');
    } else {
        console.error(`服务未能在端口 ${port} 启动，请检查上方日志。`);
        appProcess.kill();
        process.exit(1);
    }
}

function stop() {
    if (!appProcess || appProcess.killed) return;
    appProcess.kill('SIGINT');
    setTimeout(() => appProcess && !appProcess.killed && appProcess.kill(), 1500).unref();
}

process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
main().catch(error => {
    console.error(error);
    stop();
    process.exit(1);
});
