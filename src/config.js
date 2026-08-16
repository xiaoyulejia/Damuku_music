const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

function normalizeBasePath(value) {
    const text = String(value || '/order').trim();
    if (!text || text === '/') return '';
    return `/${text.replace(/^\/+|\/+$/g, '')}`;
}

function resolvePort(value, fallback = 8000) {
    const candidate = value === undefined || value === null || value === '' ? fallback : value;
    const port = Number(candidate);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`DAMUKU_PORT/web_server_port 必须是 1-65535 的整数，当前值：${candidate}`);
    }
    return port;
}

function loadVersionConfig(rootDir) {
    const versionPath = path.join(rootDir, 'config', 'version.js');
    const defaultVersionPath = path.join(rootDir, 'config', 'default', 'version.js');
    const configPath = fs.existsSync(versionPath) ? versionPath : defaultVersionPath;
    delete require.cache[require.resolve(configPath)];
    const version = require(configPath);
    if (!version || typeof version !== 'object' || !String(version.productVersion || '').trim() || !String(version.buildId || '').trim()) {
        throw new Error(`版本配置无效：${configPath}`);
    }
    return {
        productVersion: String(version.productVersion).trim(),
        buildId: String(version.buildId).trim()
    };
}

function loadRuntimeConfig(rootDir = path.resolve(__dirname, '..')) {
    const configPath = path.join(rootDir, 'config', 'config.yaml');
    const webapiPath = path.join(rootDir, 'config', 'webapi.js');
    const defaultConfigPath = path.join(rootDir, 'config', 'default', 'config.yaml');
    const defaultWebapiPath = path.join(rootDir, 'config', 'default', 'webapi.js');
    const version = loadVersionConfig(rootDir);
    const yamlPath = fs.existsSync(configPath) ? configPath : defaultConfigPath;
    const apiPath = fs.existsSync(webapiPath) ? webapiPath : defaultWebapiPath;
    const config = yaml.parse(fs.readFileSync(yamlPath, 'utf8')) || {};
    delete require.cache[require.resolve(apiPath)];
    const webapi = require(apiPath);
    const port = resolvePort(process.env.DAMUKU_PORT || config.web_server_port, 8000);
    const buildId = process.env.DAMUKU_BUILD_ID || version.buildId;
    process.env.DAMUKU_BUILD_ID = buildId;
    return {
        rootDir,
        config,
        webapi,
        productVersion: version.productVersion,
        host: config.web_server_host || '0.0.0.0',
        port,
        basePath: normalizeBasePath(webapi.BASE_PATH),
        buildId
    };
}

module.exports = { loadRuntimeConfig, normalizeBasePath, resolvePort };
