const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const MIXIN_KEY_TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
const WBI_CACHE_MS = 6 * 60 * 60 * 1000;
const DEVICE_IDENTITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function generateBuvid3() {
    return `${crypto.randomUUID().toUpperCase()}${String(crypto.randomInt(100000)).padStart(5, '0')}infoc`;
}

function wbiSign(params, mixinKey) {
    const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(signed)
        .sort()
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(signed[key]).replace(/[!'()*]/g, ''))}`)
        .join('&');
    return { ...signed, w_rid: crypto.createHash('md5').update(query + mixinKey).digest('hex') };
}

function domainMatches(hostname, domain) {
    const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

class CookieJar {
    constructor(initialCookie = '') {
        this.cookies = new Map();
        if (initialCookie) this.importCookieHeader(initialCookie, '.bilibili.com');
    }

    importCookieHeader(header, domain) {
        for (const part of String(header).split(';')) {
            const separator = part.indexOf('=');
            if (separator <= 0) continue;
            const name = part.slice(0, separator).trim();
            const value = part.slice(separator + 1).trim();
            if (name) this.cookies.set(name, { name, value, domain, path: '/', secure: false, expiresAt: 0 });
        }
    }

    set(name, value, options = {}) {
        this.cookies.set(name, {
            name,
            value,
            domain: options.domain || '.bilibili.com',
            path: options.path || '/',
            secure: Boolean(options.secure),
            expiresAt: Number(options.expiresAt) || 0
        });
    }

    absorb(setCookieHeaders, responseUrl) {
        const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : (setCookieHeaders ? [setCookieHeaders] : []);
        const response = new URL(responseUrl);
        for (const line of headers) {
            const parts = String(line).split(';').map(item => item.trim());
            const separator = parts[0]?.indexOf('=') ?? -1;
            if (separator <= 0) continue;
            const cookie = {
                name: parts[0].slice(0, separator),
                value: parts[0].slice(separator + 1),
                domain: response.hostname,
                path: '/',
                secure: false,
                expiresAt: 0
            };
            for (const attribute of parts.slice(1)) {
                const [rawName, ...rawValue] = attribute.split('=');
                const name = rawName.toLowerCase();
                const value = rawValue.join('=');
                if (name === 'domain' && value) cookie.domain = value;
                else if (name === 'path' && value) cookie.path = value;
                else if (name === 'secure') cookie.secure = true;
                else if (name === 'max-age') cookie.expiresAt = Date.now() + Number(value) * 1000;
                else if (name === 'expires') cookie.expiresAt = Date.parse(value) || 0;
            }
            if (!cookie.value || (cookie.expiresAt && cookie.expiresAt <= Date.now())) this.cookies.delete(cookie.name);
            else this.cookies.set(cookie.name, cookie);
        }
    }

    headerFor(requestUrl) {
        const request = new URL(requestUrl);
        const now = Date.now();
        const values = [];
        for (const [name, cookie] of this.cookies) {
            if (cookie.expiresAt && cookie.expiresAt <= now) {
                this.cookies.delete(name);
                continue;
            }
            if (!domainMatches(request.hostname.toLowerCase(), cookie.domain)) continue;
            if (!request.pathname.startsWith(cookie.path || '/')) continue;
            if (cookie.secure && request.protocol !== 'https:') continue;
            values.push(`${cookie.name}=${cookie.value}`);
        }
        return values.join('; ');
    }

    get(name) {
        return this.cookies.get(name)?.value || '';
    }
}

class BiliSession {
    constructor(options = {}) {
        this.http = options.http || axios.create({ timeout: 10000, validateStatus: status => status >= 200 && status < 400 });
        this.cacheFile = options.cacheFile === undefined
            ? path.resolve(__dirname, '../../cache/bili-anonymous-session.json')
            : options.cacheFile;
        const configuredCookie = options.cookie ?? process.env.BILIBILI_COOKIE ?? '';
        this.jar = options.jar || new CookieJar(configuredCookie);
        const cachedIdentity = configuredCookie ? {} : this.readCachedIdentity();
        if (!this.jar.get('buvid3')) this.jar.set('buvid3', cachedIdentity.buvid3 || generateBuvid3());
        if (!this.jar.get('buvid4') && cachedIdentity.buvid4) this.jar.set('buvid4', cachedIdentity.buvid4);
        this.deviceIdentityIssuedAt = Number(cachedIdentity.issuedAt) || 0;
        this.deviceIdentityVerified = Boolean(configuredCookie && this.jar.get('buvid3')) || Boolean(
            cachedIdentity.buvid3 &&
            cachedIdentity.buvid4 &&
            this.deviceIdentityIssuedAt > Date.now() - DEVICE_IDENTITY_MAX_AGE_MS
        );
        this.deviceBootstrap = null;
        this.uid = Number(this.jar.get('DedeUserID')) || 0;
        this.mode = this.uid > 0 ? 'login' : 'anonymous';
        this.wbiCache = null;
        this.roomCache = new Map();
    }

    readCachedIdentity() {
        if (!this.cacheFile) return {};
        try {
            const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
            return {
                buvid3: typeof parsed.buvid3 === 'string' ? parsed.buvid3 : '',
                buvid4: typeof parsed.buvid4 === 'string' ? parsed.buvid4 : '',
                issuedAt: Number(parsed.issuedAt) || 0
            };
        } catch (_) {
            return {};
        }
    }

    persistAnonymousIdentity() {
        if (!this.cacheFile) return;
        try {
            fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
            fs.writeFileSync(this.cacheFile, JSON.stringify({
                buvid3: this.jar.get('buvid3'),
                buvid4: this.jar.get('buvid4'),
                issuedAt: this.deviceIdentityIssuedAt
            }), { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
            console.warn('[BilibiliDanmu][session] 无法持久化匿名设备标识:', error.message);
        }
    }

    async request(url, config = {}) {
        const headers = {
            'user-agent': USER_AGENT,
            referer: 'https://live.bilibili.com/',
            ...config.headers
        };
        const cookie = this.jar.headerFor(url);
        if (cookie) headers.cookie = cookie;
        const response = await this.http.request({ ...config, url, headers });
        this.jar.absorb(response.headers?.['set-cookie'], response.request?.res?.responseUrl || url);
        return response;
    }

    async ensureDeviceIdentity() {
        if (this.deviceIdentityVerified) return;
        if (this.deviceBootstrap) return this.deviceBootstrap;
        this.deviceBootstrap = this.request('https://api.bilibili.com/x/frontend/finger/spi')
            .then(response => {
                const data = response.data?.data || {};
                if (response.data?.code !== 0 || !data.b_3) throw new Error(response.data?.message || 'B站未签发匿名设备标识');
                this.jar.set('buvid3', data.b_3);
                if (data.b_4) this.jar.set('buvid4', data.b_4);
                this.deviceIdentityIssuedAt = Date.now();
                this.deviceIdentityVerified = true;
                this.persistAnonymousIdentity();
            })
            .finally(() => {
                this.deviceBootstrap = null;
            });
        return this.deviceBootstrap;
    }

    async getWbiMixinKey(force = false) {
        await this.ensureDeviceIdentity();
        if (!force && this.wbiCache && Date.now() - this.wbiCache.createdAt < WBI_CACHE_MS) return this.wbiCache.key;
        const response = await this.request('https://api.bilibili.com/x/web-interface/nav');
        const wbi = response.data?.data?.wbi_img;
        if (!wbi?.img_url || !wbi?.sub_url) throw new Error('无法获取B站WBI密钥');
        const fileName = value => value.split('/').pop().split('.')[0];
        const origin = fileName(wbi.img_url) + fileName(wbi.sub_url);
        const key = MIXIN_KEY_TABLE.map(index => origin[index] || '').join('');
        this.wbiCache = { key, createdAt: Date.now() };
        return key;
    }

    async resolveRoomId(roomId, force = false) {
        await this.ensureDeviceIdentity();
        const requested = Number(roomId);
        if (!Number.isInteger(requested) || requested <= 0) throw new Error('room_id必须是正整数');
        if (!force && this.roomCache.has(requested)) return this.roomCache.get(requested);
        try {
            const response = await this.request('https://api.live.bilibili.com/xlive/web-room/v1/index/getH5InfoByRoom', {
                params: { room_id: requested }
            });
            const realRoomId = Number(
                response.data?.data?.room_info?.room_id ||
                response.data?.data?.room_info?.roomid ||
                response.data?.data?.room_id ||
                requested
            );
            this.roomCache.set(requested, realRoomId);
            this.roomCache.set(realRoomId, realRoomId);
            return realRoomId;
        } catch (_) {
            return requested;
        }
    }

    async getDanmuInfo(roomId, options = {}) {
        const realRoomId = await this.resolveRoomId(roomId, options.force);
        const requestInfo = async forceWbi => {
            const params = wbiSign(
                { id: realRoomId, type: 0, web_location: 444.8 },
                await this.getWbiMixinKey(forceWbi)
            );
            return this.request('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo', { params });
        };
        let response = await requestInfo(false);
        if (response.data?.code !== 0 && options.force) response = await requestInfo(true);
        if (response.data?.code !== 0) throw new Error(response.data?.message || '获取B站直播弹幕token失败');
        const data = response.data?.data || {};
        const hosts = [...new Set((data.host_list || [])
            .filter(item => item?.host && Number(item?.wss_port) > 0)
            .map(item => `wss://${item.host}:${item.wss_port}/sub`))];
        if (!data.token || !hosts.length) throw new Error('B站弹幕鉴权响应缺少token或host_list');
        return { roomId: realRoomId, token: data.token, hosts, uid: this.uid, raw: data };
    }

    async getHistory(roomId) {
        const realRoomId = await this.resolveRoomId(roomId);
        const response = await this.request('https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory', {
            params: { roomid: realRoomId },
            headers: { referer: `https://live.bilibili.com/${realRoomId}` }
        });
        if (response.data?.code !== 0) throw new Error(response.data?.message || '获取B站历史弹幕失败');
        return { roomId: realRoomId, items: response.data?.data?.room || [], raw: response.data };
    }

    getBuvid3() {
        return this.jar.get('buvid3');
    }

    async acknowledgeMessages(sequence) {
        const normalized = Number(sequence);
        if (!Number.isInteger(normalized) || normalized <= 1) return { skipped: true };
        const response = await this.request('https://api.live.bilibili.com/xlive/open-interface/v1/dm/message_ack', {
            method: 'POST',
            data: new URLSearchParams({ terminal: '0', sequence: String(normalized) }).toString(),
            headers: {
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
            }
        });
        if (response.data?.code !== 0) throw new Error(response.data?.message || `B站弹幕HTTP ACK失败 code=${response.data?.code}`);
        return response.data;
    }

    diagnostics() {
        return { mode: this.mode, uid: this.uid, hasBuvid3: Boolean(this.jar.get('buvid3')) };
    }
}

let sharedSession;

function getBiliSession() {
    sharedSession ??= new BiliSession();
    return sharedSession;
}

module.exports = {
    BiliSession,
    CookieJar,
    generateBuvid3,
    getBiliSession,
    wbiSign
};
