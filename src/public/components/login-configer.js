import musicPlayer from "./music-player.js?v=20260812-4";
import publicMethod from "../utils/common.js?v=20260810-41";
import musicServer from "../services/musicServers/music-server.js?v=20260812-18";

/**
 * 登录配置
 */
class LoginConfiger {

    // 空闲歌单ID
    songListId = "7294328248";
    elem_songListId = document.getElementById("songListId");

    // 历史加载的歌单ID
    // 设置由服务端房间状态统一提供，页面初始化时先使用空列表，
    // 避免依赖已废弃的 localStorage readArray 辅助函数。
    songListHistory = [];
    elem_songListHistory = document.getElementById("songListHistory");

    neteaseLoginStatus = {
        state: 'checking',
        text: '检查中...'
    };
    songListSwitchSequence = 0;
    activeSongListSwitchSequence = 0;
    lastSongListRequestStamp = 0;
    songListStatusTimer = null;

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
        window.addEventListener('bilibili-ordersong-shared-settings', event => {
            this.applySharedState(event.detail?.login);
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
        document.getElementById('selectSongList').onclick = async () => {
            const selected = this.getSelectedHistoryItem();
            if (!selected) {
                publicMethod.pageAlert("未选择歌单！");
                return;
            }
            await this.switchSongList(selected.listId, 'history', selected.platform);
        };
        document.getElementById('deleteSongListHistory').onclick = () => this.deleteSongListHistory();
        document.getElementById('clearSongListHistory').onclick = () => this.clearSongListHistory();
    }

    setSongListSwitchStatus(message, state = 'loading', autoClearMs = 0) {
        const element = document.getElementById('songListSwitchStatus');
        if (!element) return;
        clearTimeout(this.songListStatusTimer);
        element.textContent = message || '';
        element.dataset.state = state;
        if (autoClearMs > 0) {
            this.songListStatusTimer = setTimeout(() => {
                element.textContent = '';
                element.dataset.state = '';
            }, autoClearMs);
        }
    }

    setSongListSwitchControlsDisabled(disabled) {
        for (const id of ['loadSongList', 'selectSongList', 'deleteSongListHistory', 'clearSongListHistory', 'musicPlatformSelect']) {
            const element = document.getElementById(id);
            if (element) element.disabled = disabled;
        }
        if (this.elem_songListHistory) this.elem_songListHistory.disabled = disabled;
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
        }
        if (Array.isArray(state.songListHistory)) {
            this.songListHistory = state.songListHistory;
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

    getSelectedHistoryItem() {
        const selectedIndex = this.elem_songListHistory?.selectedIndex ?? -1;
        const selectedOption = selectedIndex >= 0 ? this.elem_songListHistory.options[selectedIndex] : null;
        const selectedId = selectedOption?.value || '';
        const platform = selectedOption?.dataset?.platform || musicServer.platform;
        return this.songListHistory.find(item => item.platform === platform && String(item.listId) === String(selectedId)) || null;
    }

    // 所有歌单切换都经过同一个入口，成功前不修改当前权威状态。
    async switchSongList(listId, source = 'manual', platform = musicServer.platform) {
        listId = String(listId || '').trim();
        if (!listId) {
            publicMethod.pageAlert("请输入有效歌单ID");
            return false;
        }
        const previousPlatform = musicServer.platform;
        musicServer.changePlatform(platform);
        const switchSequence = ++this.songListSwitchSequence;
        this.activeSongListSwitchSequence = switchSequence;
        let requestStamp = Date.now();
        if (requestStamp <= this.lastSongListRequestStamp) requestStamp = this.lastSongListRequestStamp + 1;
        this.lastSongListRequestStamp = requestStamp;
        this.setSongListSwitchControlsDisabled(true);
        this.setSongListSwitchStatus('正在获取歌单，请稍候…', 'loading');
        try {
            const songList = await musicServer.getServer(platform).getSongList(listId);
            if (switchSequence !== this.activeSongListSwitchSequence) return false;
            if (!Array.isArray(songList) || !songList.length) {
                if (this.activeSongListSwitchSequence === switchSequence) musicServer.changePlatform(previousPlatform);
                const message = source === 'history' ? '历史歌单为空或获取失败，当前歌单保持不变' : '歌单为空或获取失败，当前歌单保持不变';
                this.setSongListSwitchStatus(message, 'error', 6000);
                publicMethod.pageAlert(message);
                return false;
            }
            this.setSongListSwitchStatus(`歌单已获取（${songList.length} 首），正在同步到 OBS…`, 'loading');
            const requestId = `${requestStamp}-${Math.random().toString(36).slice(2)}`;
            const response = await musicPlayer.sendCommand('loadSongList', {
                requestId,
                platform,
                listId,
                songList
            });
            if (switchSequence !== this.activeSongListSwitchSequence) return false;
            if (!response?.ok || response.result?.result?.accepted === false || response.result?.result?.switched !== true) {
                const message = response?.result?.result?.reason || response?.result?.message || response?.reason || '后端拒绝切换歌单，当前歌单保持不变';
                this.setSongListSwitchStatus(message, 'error', 6000);
                publicMethod.pageAlert(message);
                return false;
            }
            this.songListId = listId;
            document.getElementById("songListId").value = listId;
            this.addSongListHistory(listId, platform);
            this.publishSharedState();
            this.setSongListSwitchStatus('歌单切换成功，OBS 已收到新歌单。', 'success', 5000);
            publicMethod.pageAlert('歌单切换成功');
            return true;
        } catch (error) {
            if (this.activeSongListSwitchSequence === switchSequence) musicServer.changePlatform(previousPlatform);
            if (switchSequence === this.activeSongListSwitchSequence) {
                const message = `歌单切换失败：${error.message || '网络错误'}`;
                this.setSongListSwitchStatus(message, 'error', 6000);
                publicMethod.pageAlert(message);
            }
            return false;
        } finally {
            if (switchSequence === this.activeSongListSwitchSequence) {
                this.setSongListSwitchControlsDisabled(false);
            }
        }
    }

    async loadSongList(listId = document.getElementById("songListId").value) {
        return this.switchSongList(listId, 'manual', musicServer.platform);
    }

    // 加载历史歌单列表
    loadSongListHistory() {
        // 设置默认歌单
        this.elem_songListId.value = this.songListId;

        // 清空option
        this.elem_songListHistory.innerHTML = '';

        // 加载历史歌单到设置页面中
        for (let i = 0; i < this.songListHistory.length; i++) {
            let option = document.createElement('option');
            option.value = this.songListHistory[i].listId;
            option.textContent = this.songListHistory[i].listName;
            option.dataset.platform = this.songListHistory[i].platform;
            this.elem_songListHistory.appendChild(option);
        }
    }

    // 添加历史歌单ID
    addSongListHistory(listId, platform = musicServer.platform) {
        // 歌单ID查重
        for (let i = 0; i < this.songListHistory.length; i++) {
            if (this.songListHistory[i].platform == platform &&
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
            platform,
            listId: listId,
            listName: listId
        });

        // 新建选项
        let elem_option = document.createElement('option');
        elem_option.value = listId;
        elem_option.textContent = listId;
        elem_option.dataset.platform = platform;
        this.elem_songListHistory.appendChild(elem_option);

        // 保存配置信息
        this.publishSharedState();
    }

    deleteSongListHistory() {
        const selectIndex = this.elem_songListHistory.selectedIndex;
        if (selectIndex < 0) {
            publicMethod.pageAlert("未选择歌单！");
            return;
        }

        const selectedOption = this.elem_songListHistory.options[selectIndex];
        const selectedItem = this.songListHistory.find(item => item.platform === selectedOption?.dataset?.platform && String(item.listId) === String(selectedOption?.value));
        if (!selectedItem) return;

        this.songListHistory = this.songListHistory.filter(item => item !== selectedItem);
        this.loadSongListHistory();
        this.publishSharedState();
        publicMethod.pageAlert(`已删除历史歌单：${selectedItem.listId}`);
    }

    clearSongListHistory() {
        this.songListHistory = [];
        this.loadSongListHistory();
        this.publishSharedState();
        publicMethod.pageAlert("历史空闲歌单已清空");
    }

}

export default new LoginConfiger();
