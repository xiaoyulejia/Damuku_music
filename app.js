const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadRuntimeConfig } = require('./src/config');
const { LocalStore } = require('./src/services/local-store');

const app = express();
const { attachLiveProxy } = require('./src/services/bili-live-ws');

// 解析 JSON 和 URL-encoded 请求体
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// JSON 请求体解析失败（尤其是大歌单超过上限）时始终返回约定格式，
// 不把 Express 默认 HTML 错误页暴露给前端。
app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large' || error?.status === 413) {
        return res.status(413).json({ code: -1, message: '歌单请求过大，最多支持约 5000 首歌曲' });
    }
    if (error instanceof SyntaxError && error.status === 400 && error.body) {
        return res.status(400).json({ code: -1, message: '请求 JSON 格式无效' });
    }
    return next(error);
});

console.log("===============正在启动服务器...=============");
const runtime = loadRuntimeConfig(__dirname);
process.env.DAMUKU_BUILD_ID = runtime.buildId;
const localStore = new LocalStore(__dirname);
// ==================== 配置文件初始化 ====================
// 如果运行时配置不存在，则从 default 目录拷贝
const runtimeConfigPath = path.join(__dirname, 'config/config.yaml');
const runtimeWebapiPath = path.join(__dirname, 'config/webapi.js');
const runtimeVersionPath = path.join(__dirname, 'config/version.js');
if (!fs.existsSync(runtimeConfigPath)) {
    fs.copyFileSync(path.join(__dirname, 'config/default/config.yaml'), runtimeConfigPath);
    console.log('已从默认配置创建 config/config.yaml');
}
if (!fs.existsSync(runtimeWebapiPath)) {
    fs.copyFileSync(path.join(__dirname, 'config/default/webapi.js'), runtimeWebapiPath);
    console.log('已从默认配置创建 config/webapi.js');
}
if (!fs.existsSync(runtimeVersionPath)) {
    fs.copyFileSync(path.join(__dirname, 'config/default/version.js'), runtimeVersionPath);
    console.log('已从默认配置创建 config/version.js');
}
// 将运行时配置拷贝到 public 目录供浏览器使用。
fs.copyFileSync(runtimeWebapiPath, path.join(__dirname, 'src/public/webapi.js'));
const versionForBrowser = require(runtimeVersionPath);
const publicVersionScript = `(() => {
    const DAMUKU_VERSION = ${JSON.stringify(versionForBrowser)};
    window.__DAMUKU_PRODUCT_VERSION = DAMUKU_VERSION.productVersion;
    window.__DAMUKU_FRONTEND_BUILD_ID = DAMUKU_VERSION.buildId;
    const renderVersion = () => {
        document.querySelectorAll('[data-damuku-product-version]').forEach(element => {
            element.textContent = DAMUKU_VERSION.productVersion;
        });
        document.querySelectorAll('[data-damuku-build-id]').forEach(element => {
            element.textContent = DAMUKU_VERSION.buildId;
        });
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderVersion, { once: true });
    } else {
        renderVersion();
    }
})();
`;
fs.writeFileSync(path.join(__dirname, 'src/public/version.js'), publicVersionScript, 'utf8');

// 读取服务端配置
const config = runtime.config;

// 读取 webapi 配置
const webapiConfig = runtime.webapi;

// 静态文件（挂载在 BASE_PATH 基础路径下）
const BASE_PATH = runtime.basePath;
app.use(BASE_PATH, express.static(path.join(__dirname, 'src/public'), {
    setHeaders(res, filePath) {
        if (/\.(html|js|css)$/i.test(filePath) || /webapi\.js$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ==================== 按需启动集成服务 ====================
/**
 * 判断服务地址是否为集成挂载路径
 * 挂载路径：以 "/" 开头的路径（如 "/bili-api"），由主服务直接挂载
 * 独立服务：完整的远程地址，主服务不启动该服务
 *   - 带协议：http://localhost:3300、https://api.example.com
 *   - 协议相对：//localhost:3300
 *   - 无协议主机：localhost:3300、127.0.0.1:3300、example.com:3300
 */
function isMountPath(url) {
    if (!url || typeof url !== 'string') return false;
    // 以 "/" 开头且不是 "//" 开头（// 开头是协议相对URL，属于外部地址）
    return url.startsWith('/') && !url.startsWith('//');
}

// B站开放平台 API
if (isMountPath(webapiConfig.bili_api)) {
    const encrypt = require('./src/utils/encrypt');
    const biliRouter = require('./src/routers/bili-router');
    // 设置秘钥
    encrypt.access_key_id = config.access_key_id || '';
    encrypt.access_key_secred = config.access_key_secred || '';
    // 设置服务
    const biliPath = webapiConfig.bili_api || '/bili-api';
    app.use(BASE_PATH + biliPath, biliRouter);
    console.log(`B站开放平台API服务已挂载：http://localhost:${runtime.port}${BASE_PATH}${biliPath}`);
} else {
    console.log(`B站API服务为独立服务：${webapiConfig.bili_api}`);
}

// 网易云音乐 API
if (isMountPath(webapiConfig.netease_api)) {
    const NeteaseCloudMusicApi = require('./src/services/netease-api');
    const neteasePath = webapiConfig.netease_api || '/netease_api';
    app.use(BASE_PATH + neteasePath, async (req, res) => {
        const startedAt = Date.now();
        try {
            let apiPath = req.path.replace(/^\//, '').replace(/\//g, '_');
            const apiFunc = NeteaseCloudMusicApi[apiPath];
            if (!apiFunc) {
                return res.status(404).json({ error: `未知的网易云API: ${apiPath}` });
            }
            const query = { ...req.query, ...req.body };
            if (!query.cookie) query.cookie = localStore.getNeteaseCookie();
            const requestLog = {
                api: apiPath,
                hasCookie: Boolean(query.cookie),
                params: Object.keys(query).filter(key => key !== 'cookie')
            };
            if (query.keywords) requestLog.keywords = String(query.keywords).slice(0, 80);
            if (query.id) requestLog.id = String(query.id);
            console.log('[Netease][request]', requestLog);
            const result = await apiFunc(query);
            console.log('[Netease][response]', {
                api: apiPath,
                status: result.status,
                code: result.body?.code,
                message: result.body?.message || result.body?.msg || '',
                elapsedMs: Date.now() - startedAt
            });
            res.status(result.status).json(result.body);
        } catch (error) {
            const status = Number(error?.status || error?.response?.status) || 502;
            const detail = error?.body || error?.response?.data || error?.message || String(error);
            console.error('[Netease][error]', {
                api: req.path,
                status,
                detail,
                message: error?.message || String(error),
                elapsedMs: Date.now() - startedAt
            });
            res.status(status).json({
                code: -1,
                message: '网易云接口请求失败',
                detail
            });
        }
    });
    console.log(`网易云音乐API服务已挂载：http://localhost:${runtime.port}${BASE_PATH}${neteasePath}`);
} else {
    console.log(`网易云音乐API服务为独立服务：${webapiConfig.netease_api}`);
}

// 获取本机所有局域网地址
function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}

// 监听端口
const host = runtime.host;
const port = runtime.port;
const server = app.listen(port, host, () => {
    console.log("=================服务已启动==================");
    console.log(`本地地址：http://localhost:${port}${BASE_PATH}`);
    if (host === '0.0.0.0') {    
        const ips = getLocalIPs();
        for (const ip of ips) {
            console.log(`网络地址：http://${ip}:${port}${BASE_PATH}`);
        }
    } else {
        console.log(`服务已启动：http://${host}:${port}${BASE_PATH}`);
    }
    console.log("");
});

if (isMountPath(webapiConfig.bili_api)) {
    attachLiveProxy(server, BASE_PATH, webapiConfig.bili_api);
}
