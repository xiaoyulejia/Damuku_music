import publicMethod from "../../utils/common.js?v=20260812-5";
import { mergeTranslation, parseLrc } from "../lyric-parser.mjs";

class WyMusicServer {

    // 服务器地址
    baseUrl = publicMethod.resolveApiBase(window.API_CONFIG?.netease_api);

    cookie = (() => {
        const value = localStorage.getItem("wycookie");
        if (!value) return null;
        try {
            const parsed = JSON.parse(value);
            return typeof parsed === 'string' ? parsed : value;
        } catch (_) {
            return value;
        }
    })();

    constructor() {
        this.debug = this.getDebugMode();
    }

    getDebugMode() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        const value = new URLSearchParams(query).get('debug') || '';
        return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    }

    debugLog(label, value) {
        if (!this.debug) return;
        if (typeof value === 'undefined') console.debug(`[NeteaseMusic][debug] ${label}`);
        else console.debug(`[NeteaseMusic][debug] ${label}`, value);
    }

    describeUrl(url) {
        if (!url) return '';
        try {
            const parsed = new URL(url, window.location.href);
            return `${parsed.origin}${parsed.pathname}`;
        } catch (_) {
            return '[无法解析的地址]';
        }
    }

    // 游客登录
    async anonimousLogin() {
        let data = null;
        await axios({
            method: "get",
            url: this.baseUrl + "/register/anonimous",
        }).then(function (resp) {
            data = resp.data;
        }).catch(function (error) {
            console.log("游客登录失败！", error.response);
        });
        return data;
    }

    // 获取用户详情
    async getUserDetail() {
        let data = null;
        await axios({
            method: "get",
            url: this.baseUrl + "/user/account",
            params: {
                cookie: this.cookie
            }
        }).then(function (resp) {
            data = resp.data;
        }).catch(function (error) {
            console.log("获取用户详情失败!", error.response);
        });
        return data;
    }

    // 获取登录状态
    async getLoginStatus() {
        let result = null;
        await axios({
            method: "get",
            url: this.baseUrl + "/login/status",
            timeout: 8000,
            params: {
                cookie: this.cookie
            }
        }).then(function (resp) {
            const payload = resp.data || {};
            const data = payload.data || {};
            const profile = data.profile || null;
            const account = data.account || null;
            result = {
                loggedIn: Boolean(profile || account),
                profile,
                account,
                nickname: profile?.nickname || profile?.name || '',
                code: payload.code
            };
        }).catch(function (error) {
            console.log("获取登录状态失败!", error.response);
            result = { loggedIn: false, error: true };
        });
        return result;
    }

    // 获取二维码
    async getQrKey() {
        let unikey = null;
        await axios({
            method: "get",
            url: this.baseUrl + "/login/qr/key",
            params: {
                timestamp: Date.now(),
            }
        }).then(function (resp) {
            unikey = resp.data.data.unikey;
        }).catch(function (error) {
            console.log("获取二维码key失败!", error.response);
        });
        return unikey;
    }

    // 获取二维码图片
    async getQrPicture(key) {
        let qrImgUrl = null;
        await axios({
            method: "get",
            url: this.baseUrl + "/login/qr/create",
            params: {
                key: key,
                qrimg: true,
                timestamp: Date.now(),
            }
        }).then(function (resp) {
            qrImgUrl = resp.data.data.qrimg;
        }).catch(function (error) {
            console.log("二维码图片获取失败!", error.response);
        });
        return qrImgUrl;
    }

    // 检查二维码扫描状态
    async checkQrStatus(key) {
        let data = null;
        await axios({
            method: "get",
            url: this.baseUrl + "/login/qr/check",
            params: {
                key: key,
                timestamp: Date.now(),
            }
        }).then(function (resp) {
            // cookie
            data = resp.data;
        }).catch(function (error) {
            console.log("获取二维码扫描状态失败!", error.response);
        });
        return data;
    }

    // 退出登录
    async logout() {
        let data = null;
        await axios({
            method: "get",
            url: this.baseUrl + "/logout",
            params: {
                cookie: this.cookie
            }
        }).catch(function (error) {
            console.log("退出登录失败！", error.response);
        });
        return data;
    }

    /* 搜索歌曲信息 
        @param keyword 关键词
    */
    async getSongInfo(keyword) {
        const startedAt = Date.now();
        this.debugLog('歌曲搜索请求', {
            method: 'GET',
            url: `${this.baseUrl}/search`,
            keywords: keyword,
            cookiePresent: Boolean(this.cookie)
        });
        try {
            const resp = await axios({
                method: "get",
                url: this.baseUrl + "/search",
                params: {
                    cookie: this.cookie,
                    keywords: keyword,
                    limit: 10,
                    type: 1,
                }
            });
            const songs = resp.data?.result?.songs || [];
            const first = songs[0];
            const song = first ? {
                platform: "wy",
                sid: first.id,
                sname: first.name,
                sartist: first.artists?.[0]?.name || '未知歌手',
                duration: (first.duration || 0) / 1000,
            } : null;
            this.debugLog('歌曲搜索响应', {
                status: resp.status,
                code: resp.data?.code,
                count: songs.length,
                song: song ? { sid: song.sid, sname: song.sname, artist: song.sartist } : null,
                elapsedMs: Date.now() - startedAt
            });
            return song;
        } catch (error) {
            this.debugLog('歌曲搜索失败', {
                status: error.response?.status,
                response: error.response?.data,
                message: error.message,
                elapsedMs: Date.now() - startedAt
            });
            console.log("歌曲搜索失败!", error.response?.data || error.message);
            return null;
        }
    }

    /* 获取歌曲链接
        @param songId 歌曲Id
    */
    async getSongUrl(songId) {
        const startedAt = Date.now();
        this.debugLog('歌曲播放地址请求', {
            method: 'GET',
            url: `${this.baseUrl}/song/url/v1`,
            songId,
            level: 'standard',
            cookiePresent: Boolean(this.cookie)
        });
        try {
            const resp = await axios({
                method: "get",
                url: this.baseUrl + "/song/url/v1",
                timeout: 12000,
                params: {
                    cookie: this.cookie,
                    id: songId,
                    level: "standard",
                }
            });
            const payload = resp.data || {};
            const item = payload.data?.[0] || null;
            const url = item?.url || null;
            this.debugLog('歌曲播放地址响应', {
                status: resp.status,
                code: payload.code,
                message: payload.message || '',
                songId,
                hasUrl: Boolean(url),
                audioUrl: this.describeUrl(url),
                elapsedMs: Date.now() - startedAt
            });
            if (payload.code < 0) console.log("歌曲链接获取失败!", payload.message);
            return url;
        } catch (error) {
            this.debugLog('歌曲播放地址失败', {
                songId,
                status: error.response?.status,
                response: error.response?.data,
                message: error.message,
                elapsedMs: Date.now() - startedAt
            });
            console.log("歌曲链接获取失败!", error.response?.data || error.message);
            return null;
        }
    }

    async getLyrics(songId, { signal } = {}) {
        const request = async endpoint => {
            const resp = await axios({
                method: 'get',
                url: this.baseUrl + endpoint,
                timeout: 10000,
                signal,
                params: { cookie: this.cookie, id: songId }
            });
            const payload = resp.data || {};
            if (payload.code !== 200) throw new Error(`歌词接口返回 ${payload.code ?? '未知状态'}`);
            return payload;
        };

        let payload;
        try {
            payload = await request('/lyric/new');
        } catch (error) {
            if (error?.code === 'ERR_CANCELED' || error?.name === 'AbortError') throw error;
            this.debugLog('新版歌词接口失败，回退旧接口', { songId, message: error.message });
            try {
                payload = await request('/lyric');
            } catch (fallbackError) {
                if (fallbackError?.code === 'ERR_CANCELED' || fallbackError?.name === 'AbortError') throw fallbackError;
                throw fallbackError;
            }
        }

        // NeteaseCloudMusicApi 的 /lyric 和 /lyric/new 将 lrc/tlyric
        // 放在响应顶层；兼容部分代理额外包裹 data 的返回格式。
        const data = payload.data || payload;
        const original = data.lrc?.lyric || '';
        const translation = data.tlyric?.lyric || '';
        const romanization = data.romalrc?.lyric || '';
        const noLyrics = Boolean(data.nolyric || data.uncollected || (!original && !translation));
        return {
            platform: 'wy',
            songId: String(songId),
            original,
            translation,
            romanization,
            instrumental: Boolean(data.nolyric && !original),
            noLyrics,
            lines: noLyrics ? [] : mergeTranslation(parseLrc(original), translation)
        };
    }

    /* 获取歌单列表 
        @param listId 歌单Id
    */
    async getSongList(listId) {
        const startedAt = Date.now();
        this.debugLog('歌单请求', {
            method: 'GET',
            url: `${this.baseUrl}/playlist/track/all`,
            listId,
            cookiePresent: Boolean(this.cookie)
        });
        try {
            const resp = await axios({
                method: "get",
                url: this.baseUrl + "/playlist/track/all",
                timeout: 15000,
                params: {
                    cookie: this.cookie,
                    id: listId
                }
            });
            const songs = resp.data?.songs || [];
            const songList = songs.map(item => ({
                uid: 0,
                uname: "空闲歌单",
                song: {
                    platform: "wy",
                    sid: item.id,
                    url: null,
                    sname: item.name,
                    sartist: item.ar?.[0]?.name || '未知歌手',
                }
            }));
            this.debugLog('歌单响应', {
                status: resp.status,
                listId,
                count: songList.length,
                elapsedMs: Date.now() - startedAt
            });
            return songList;
        } catch (error) {
            this.debugLog('歌单请求失败', {
                listId,
                status: error.response?.status,
                response: error.response?.data,
                message: error.message,
                elapsedMs: Date.now() - startedAt
            });
            console.log("歌单信息获取失败!", error.response?.data || error.message);
            return [];
        }
    }
}

export default new WyMusicServer();
