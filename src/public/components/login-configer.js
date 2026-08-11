import musicPlayer from "./music-player.js?v=20260812-4";
import publicMethod from "../utils/common.js?v=20260810-41";
import musicServer from "../services/musicServers/music-server.js?v=20260810-42";

function readArray(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(value) ? value : [];
    } catch (_) {
        return [];
    }
}

/**
 * 登录配置
 */
class LoginConfiger {

    // 空闲歌单ID
    songListId = localStorage.getItem("songListId") || "7294328248";
    elem_songListId = document.getElementById("songListId");

    // 历史加载的歌单ID
    songListHistory = readArray("songListHistory");
    elem_songListHistory = document.getElementById("songListHistory");

    neteaseLoginStatus = {
        state: 'checking',
        text: '检查中...'
    };

    constructor() {
        // 加载历史歌单列表
        this.loadSongListHistory();

        // 添加按钮监听事件
        this.addListener();
        // 控制页的网易云 Cookie 只存在本地浏览器，启动时主动交给本机同步服务，
        // 让真正播放的 OBS 页面也能加载歌单和歌曲链接。
        if (musicPlayer.isMirrorMode) {
            musicPlayer.pushSharedCredentials();
            // 控制页不能依赖 OBS 是否在线来结束“检查中”。有本地 Cookie
            // 就检查本地登录态，没有就明确显示未登录；共享状态随后再覆盖为 OBS 的结果。
            if (musicServer.getServer('wy').cookie) {
                this.refreshNeteaseLoginStatus({ silent: true, publish: false });
            } else {
                this.setNeteaseLoginStatus({ state: 'logged-out', text: '未登录' }, false);
            }
        }
        // 控制页的 localStorage 可能是旧浏览器/旧房间数据，不能在启动时回写 OBS。
        if (!musicPlayer.isMirrorMode) this.publishSharedState();
        window.addEventListener('bilibili-ordersong-shared-settings', event => {
            this.applySharedState(event.detail?.login);
        });
        window.addEventListener('bilibili-ordersong-command', event => {
            const command = event.detail;
            if (!musicPlayer.isMirrorMode && command?.command === 'loadSongList') {
                this.loadSongList(command.value);
            }
        });
        window.addEventListener('bilibili-ordersong-credentials-changed', () => {
            // 播放端之前因没有登录态加载失败时，收到 Cookie 后自动重试一次。
            if (!musicPlayer.isMirrorMode && !musicPlayer.audio.src && !musicPlayer.idleSongList.length) {
                this.loadSongList(this.songListId);
            }
        });
        if (window.__lastSharedSettings?.login) {
            this.applySharedState(window.__lastSharedSettings.login);
        }
        if (!musicPlayer.isMirrorMode) {
            this.refreshNeteaseLoginStatus({ silent: true });
        }

        console.log("登录配置初始化完成");
    }

    // 给页面配置项添加点击事件
    addListener() {
        // 音乐平台切换
        document.getElementById('musicPlatformSelect').onchange = (e) => this.swithPlatform(e);

        // 网易二维码登录
        document.getElementById('qrButton').onclick = () => this.updateQrPicture();
        document.getElementById('wyLoginRefresh').onclick = () => this.refreshNeteaseLoginStatus();

        // qq cookie登录
        document.getElementById('ckButton').onclick = () => this.cookieLogin();

        // 加载歌单按钮
        document.getElementById('loadSongList').onclick = () => this.loadSongList();

        // 选择历史歌单ID
        document.getElementById('selectSongList').onclick = () => {
            const listId = this.elem_songListHistory.value || this.elem_songListHistory.options?.[0]?.value;
            if (!listId) {
                publicMethod.pageAlert("未选择歌单！");
                return;
            }
            this.loadSongList(listId);
        };
        document.getElementById('deleteSongListHistory').onclick = () => this.deleteSongListHistory();
        document.getElementById('clearSongListHistory').onclick = () => this.clearSongListHistory();
    }

    getSharedState() {
        return {
            songListId: this.songListId,
            songListHistory: this.songListHistory,
            neteaseLoginStatus: this.neteaseLoginStatus
        };
    }

    publishSharedState() {
        const state = this.getSharedState();
        window.__loginSettingsState = state;
        window.dispatchEvent(new CustomEvent('bilibili-ordersong-settings-changed', {
            detail: { login: state }
        }));
    }

    applySharedState(state) {
        if (!state) return;
        if (typeof state.songListId === 'string' && state.songListId) {
            this.songListId = state.songListId;
            this.elem_songListId.value = state.songListId;
            localStorage.setItem("songListId", state.songListId);
        }
        if (Array.isArray(state.songListHistory)) {
            this.songListHistory = state.songListHistory;
            localStorage.setItem("songListHistory", JSON.stringify(this.songListHistory));
            this.loadSongListHistory();
        }
        if (state.neteaseLoginStatus) this.setNeteaseLoginStatus(state.neteaseLoginStatus, false);
        window.__loginSettingsState = this.getSharedState();
    }

    setNeteaseLoginStatus(status, publish = true) {
        this.neteaseLoginStatus = {
            state: status?.state || 'error',
            text: status?.text || '状态未知',
            nickname: status?.nickname || ''
        };
        const element = document.getElementById('wyLoginStatus');
        if (element) {
            element.dataset.state = this.neteaseLoginStatus.state;
            element.textContent = this.neteaseLoginStatus.text;
            element.title = this.neteaseLoginStatus.nickname || '';
        }
        if (publish) this.publishSharedState();
    }

    async refreshNeteaseLoginStatus({ silent = false, publish = true } = {}) {
        this.setNeteaseLoginStatus({ state: 'checking', text: '检查中...' }, false);
        const server = musicServer.getServer('wy');
        if (!server.cookie) {
            this.setNeteaseLoginStatus({ state: 'logged-out', text: '未登录' }, publish);
            return false;
        }

        const result = await server.getLoginStatus();
        if (result?.loggedIn) {
            const nickname = result.nickname || result.profile?.nickname || '';
            this.setNeteaseLoginStatus({
                state: 'logged-in',
                text: nickname ? `已登录：${nickname}` : '已登录',
                nickname
            }, publish);
            return true;
        }

        this.setNeteaseLoginStatus({
            state: result?.error ? 'error' : 'logged-out',
            text: result?.error ? '检查失败' : '未登录'
        }, publish);
        if (!silent && result?.error) publicMethod.pageAlert('网易云登录状态检查失败');
        return false;
    }

    // 切换音乐平台
    async swithPlatform(e) {
        document.getElementById('loginForm').style.left = (-400 * e.target.selectedIndex) + "px";

        // 切换音乐API服务对象
        musicServer.changePlatform(e.target.value);
        this.loadSongListHistory();
        if (e.target.value === 'wy') this.refreshNeteaseLoginStatus({ silent: true });
    }

    // 扫码登录，更新二维码
    async updateQrPicture() {
        // 二维码图片
        let qrImg = document.getElementById('qrImg');
        // 先获取二维码的key
        let unikey = await musicServer.getServer("wy").getQrKey();
        if (!unikey) {
            qrImg.textContent = "二维码获取失败！";
            return;
        }

        // 用二维码key获取二维码图片地址
        let qrUrl = await musicServer.getServer("wy").getQrPicture(unikey);

        // 显示二维码/设置不可点击刷新
        qrImg.setAttribute("src", qrUrl);

        // 轮询二维码状态
        let qrCheck = setInterval(async () => {
            let data = await musicServer.getServer("wy").checkQrStatus(unikey);
            if (!data) {
                // 二维码失效
                clearInterval(qrCheck);
                publicMethod.pageAlert("二维码获取失败!");
            } else if (data.code == 800) {
                // 二维码过期
                clearInterval(qrCheck);
                publicMethod.pageAlert("二维码已过期");
            } else if (data.code == 803) {
                // 授权成功, 保存cookie
                musicServer.getServer("wy").cookie = data.cookie;
                localStorage.setItem("wycookie", typeof data.cookie === 'string' ? data.cookie : JSON.stringify(data.cookie));
                qrImg.setAttribute("src", "");
                clearInterval(qrCheck);
                await musicPlayer.pushSharedCredentials();
                await this.refreshNeteaseLoginStatus({ silent: true });
                publicMethod.pageAlert("登录成功!");
            }
        }, 3000)
    }

    // cookie登录，设置cookie
    async cookieLogin() {
        const qqNumber = document.getElementById('qqNumber').value;
        if (!qqNumber) {
            publicMethod.pageAlert("请输入QQ号");
            return;
        }
        const cookie = document.getElementById('ckText').value;
        if (!cookie) {
            publicMethod.pageAlert("请输入cookie");
            return;
        }

        const setResult = await musicServer.getServer("qq").setCookie(cookie);
        if (setResult) {
            publicMethod.pageAlert("QQ设置cookie成功!");
        } else {
            publicMethod.pageAlert("QQ设置cookie失败!");
        }

        // 获取QQ号指定的cookie
        const getResult = await musicServer.getServer("qq").getCookie(qqNumber);
        if (getResult) {
            publicMethod.pageAlert("获取cookie成功!");
        } else {
            publicMethod.pageAlert("获取cookie失败!");
        }
    }

    // 加载空闲歌单
    async loadSongList(listId = document.getElementById("songListId").value) {
        listId = String(listId || '').trim();
        document.getElementById("songListId").value = listId;
        // 无效ID
        if (!listId) {
            publicMethod.pageAlert("请输入有效歌单ID");
            return;
        }

        // 控制页也先读取歌单，然后把完整列表交给后端保存；OBS 不再依赖
        // 自己的 localStorage 或浏览器 Cookie 才能看到控制页选择的歌单。
        let songList = await musicServer.getServer().getSongList(listId);
        this.songListId = listId;
        this.addSongListHistory(listId);
        localStorage.setItem("songListId", this.songListId);
        this.publishSharedState();
        musicPlayer.sendCommand('loadSongList', {
            listId,
            songList: publicMethod.shuffle(Array.isArray(songList) ? songList : [])
        });
        if (songList.length) {
            publicMethod.pageAlert("已将空闲歌单交给后端，OBS 将自动开始播放");
            return true;
        }
        publicMethod.pageAlert("歌单暂时获取失败，已通知 OBS 使用共享登录态重试");
        return false;
    }

    // 加载历史歌单列表
    loadSongListHistory() {
        // 设置默认歌单
        this.elem_songListId.value = this.songListId;

        // 清空option
        this.elem_songListHistory.innerHTML = '';

        // 加载历史歌单到设置页面中
        for (let i = 0; i < this.songListHistory.length; i++) {
            if (this.songListHistory[i].platform != musicServer.platform) {
                continue;
            }
            let option = document.createElement('option');
            option.value = this.songListHistory[i].listId;
            option.textContent = this.songListHistory[i].listName;
            this.elem_songListHistory.appendChild(option);
        }
    }

    // 添加历史歌单ID
    addSongListHistory(listId) {
        // 歌单ID查重
        for (let i = 0; i < this.songListHistory.length; i++) {
            if (this.songListHistory[i].platform == musicServer.platform &&
                this.songListHistory[i].listId == listId) {
                return;
            }
        }
        // 限长
        if (this.songListHistory.length >= 50) {
            this.songListHistory.shift();
        }

        // 添加歌单信息
        this.songListHistory.push({
            platform: musicServer.platform,
            listId: listId,
            listName: listId
        });

        // 新建选项
        let elem_option = document.createElement('option');
        elem_option.value = listId;
        elem_option.textContent = listId;
        this.elem_songListHistory.appendChild(elem_option);

        // 保存配置信息
        localStorage.setItem("songListHistory", JSON.stringify(this.songListHistory));
        this.publishSharedState();
    }

    deleteSongListHistory() {
        const selectIndex = this.elem_songListHistory.selectedIndex;
        if (selectIndex < 0) {
            publicMethod.pageAlert("未选择歌单！");
            return;
        }

        const visibleItems = this.songListHistory.filter(item => item.platform === musicServer.platform);
        const selectedItem = visibleItems[selectIndex];
        if (!selectedItem) return;

        this.songListHistory = this.songListHistory.filter(item => item !== selectedItem);
        localStorage.setItem("songListHistory", JSON.stringify(this.songListHistory));
        this.loadSongListHistory();
        this.publishSharedState();
        publicMethod.pageAlert(`已删除历史歌单：${selectedItem.listId}`);
    }

    clearSongListHistory() {
        this.songListHistory = [];
        localStorage.setItem("songListHistory", "[]");
        this.loadSongListHistory();
        this.publishSharedState();
        publicMethod.pageAlert("历史空闲歌单已清空");
    }

}

export default new LoginConfiger();
