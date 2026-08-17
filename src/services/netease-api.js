// NeteaseCloudMusicApi 的兼容层。
// 4.32.0 的 login_qr_check 在网络异常时会在 catch 中引用 try 块内的
// result，导致原始网络错误被二次 ReferenceError 覆盖。这里保留原始
// 错误并只替换这个有问题的接口实现。
const neteaseApi = require('NeteaseCloudMusicApi');
const request = require('NeteaseCloudMusicApi/util/request');
const createOption = require('NeteaseCloudMusicApi/util/option');
const { cookieToJson } = require('NeteaseCloudMusicApi/util');

async function loginQrCheck(query = {}) {
    const normalizedQuery = {
        ...query,
        cookie: typeof query.cookie === 'string'
            ? cookieToJson(query.cookie)
            : (query.cookie || {})
    };
    const data = {
        key: query.key,
        type: 3
    };
    const result = await request(
        '/api/login/qrcode/client/login',
        data,
        createOption(normalizedQuery)
    );
    const cookie = Array.isArray(result?.cookie) ? result.cookie : [];
    return {
        status: 200,
        body: {
            ...(result?.body || {}),
            cookie: cookie.join(';')
        },
        cookie
    };
}

neteaseApi.login_qr_check = loginQrCheck;

module.exports = neteaseApi;
