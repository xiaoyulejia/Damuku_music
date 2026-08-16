// 兼容旧的 require('./build-info') 调用；实际版本统一由 config/version.js 提供。
const path = require('path');
const fs = require('fs');
const defaultPath = path.join(__dirname, '..', 'config', 'default', 'version.js');
const runtimePath = path.join(__dirname, '..', 'config', 'version.js');
const version = require(fs.existsSync(runtimePath) ? runtimePath : defaultPath);
const BUILD_ID = version.buildId;

module.exports = { BUILD_ID, PRODUCT_VERSION: version.productVersion };
