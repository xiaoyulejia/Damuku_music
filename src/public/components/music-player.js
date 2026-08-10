import orderConfiger from "./order-configer.js?v=20260810-8";
import publicMethod from "../utils/common.js?v=20260810-8";
import musicServer from "../services/musicServers/music-server.js?v=20260810-8";

/**
 * 音乐播放器
 * 包括播放、暂停、下一首等功能
 */
class MusicPlayer {
    //  音频对象
    audio = new Audio();

    // 用户点歌队列
    orderList = [];
    elem_orderList = document.getElementById('orderList');

    // 空闲歌单播放索引
    idleIndex = 0;

    // 空闲歌单列表 
    idleSongList = [];

    // 歌曲播放时音量淡入，降低卡顿影响
    playFadeIn = null;

    // 切歌锁，防止多次触发 playNext 导致列表错位
    isSwitching = false;

    // 待执行标记：切歌期间再次请求切歌时，标记为待执行，避免操作丢失
    pendingNext = false;

    // 当前播放歌曲，用于同步 H5 播放卡片
    currentSong = null;
    currentRequester = '';
    playerState = '等待播放';

    // livemode=false 页面作为 OBS 播放页的镜像，不再创建第二个播放器
    isMirrorMode = false;
    stateChannel = null;
    stateTimer = null;
    statePollTimer = null;
    statePulling = false;
    statePushQueue = Promise.resolve();
    commandPulling = false;
    stateStorageKey = 'bilibiliOrdersongSharedState';
    lastSharedStateAt = 0;
    commandPollTimer = null;
    commandStartedAt = Date.now();
    lastCommandId = 0;
    handledCommandIds = new Set();
    volumePercent = 50;

    constructor() {
        this.isMirrorMode = !this.getPageLiveMode();
        const roomId = this.getPageRoomId() || 'default';
        this.stateStorageKey = `bilibiliOrdersongSharedState:${roomId}`;
        this.volumePercent = Number(localStorage.getItem('playerVolume') || 50);
        this.applyVolume(this.volumePercent);
        this.initStateSync();
        this.addListener();
        window.addEventListener('bilibili-ordersong-settings-changed', event => {
            if (!this.isMirrorMode) {
                this.publishState();
                return;
            }
            this.sendCommand('settings', {
                order: event.detail?.order || window.__orderSettingsState || null,
                login: event.detail?.login || window.__loginSettingsState || null
            });
        });
        this.updateQueueView();
        console.log("音乐播放器初始化完成");
    }

    getPageLiveMode() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        const params = new URLSearchParams(query);
        if (params.get('settings') === '1') return true;
        return !['0', 'false', 'no', 'off'].includes((params.get('livemode') || 'true').toLowerCase());
    }

    getPageRoomId() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        return new URLSearchParams(query).get('roomid') || new URLSearchParams(query).get('room_id') || '';
    }

    initStateSync() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        if (new URLSearchParams(query).get('settings') === '1') return;
        if (typeof BroadcastChannel === 'function') {
            this.stateChannel = new BroadcastChannel(`bilibili-ordersong-state:${this.getPageRoomId() || 'default'}`);
            this.stateChannel.onmessage = event => this.handleStateMessage(event.data);
        }
        window.addEventListener('storage', event => {
            if (this.isMirrorMode && event.key === this.stateStorageKey && event.newValue) {
                try { this.applySharedState(JSON.parse(event.newValue)); } catch (_) { }
            }
        });
        if (this.isMirrorMode) {
            this.requestSharedState();
            this.statePollTimer = setInterval(() => this.pullSharedState(), 1000);
        } else {
            this.publishState();
            this.stateTimer = setInterval(() => this.publishState(), 1000);
            this.commandPollTimer = setInterval(() => this.pullSharedCommands(), 500);
        }
    }

    requestSharedState() {
        try {
            const state = JSON.parse(localStorage.getItem(this.stateStorageKey) || 'null');
            if (state) this.applySharedState(state);
        } catch (_) { }
        this.stateChannel?.postMessage({ type: 'request-state' });
        this.pullSharedState();
    }

    async pullSharedState() {
        if (this.statePulling) return;
        const apiBase = `${window.API_CONFIG?.BASE_PATH || ''}${window.API_CONFIG?.bili_api || ''}`;
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId) return;
        this.statePulling = true;
        try {
            const response = await fetch(`${apiBase}/live/sync-state?room_id=${encodeURIComponent(roomId)}`, {
                cache: 'no-store'
            });
            const result = await response.json();
            if (result.code === 0 && result.data) this.applySharedState(result.data);
        } catch (_) {
            // 服务器端点不可用时，仍保留同浏览器内的 BroadcastChannel/localStorage 同步。
        } finally {
            this.statePulling = false;
        }
    }

    handleStateMessage(message) {
        if (!message) return;
        if (message.type === 'state' && this.isMirrorMode) {
            this.applySharedState(message.state);
        } else if (message.type === 'request-state' && !this.isMirrorMode) {
            this.publishState();
        } else if (message.type === 'command' && !this.isMirrorMode) {
            this.handleCommand(message);
        }
    }

    handleCommand(message) {
        if (!message || (message.id && this.handledCommandIds.has(message.id))) return;
        if (message.id) {
            this.handledCommandIds.add(message.id);
            if (this.handledCommandIds.size > 100) {
                this.handledCommandIds.delete(this.handledCommandIds.values().next().value);
            }
        }
        if (message.command === 'next') this.playNext();
        if (message.command === 'toggle') this.togglePlayback();
        if (message.command === 'volume') this.setVolume(message.value);
        if (message.command === 'unlockAudio' && !this.isMirrorMode) {
            this.unlockPlayback();
        }
        if (message.command === 'loadSongList' && message.value && !this.isMirrorMode) {
            window.dispatchEvent(new CustomEvent('bilibili-ordersong-command', {
                detail: { command: message.command, value: message.value }
            }));
        }
        if (message.command === 'settings' && message.value) {
            window.__lastSharedSettings = message.value;
            window.dispatchEvent(new CustomEvent('bilibili-ordersong-shared-settings', {
                detail: message.value
            }));
            this.publishState();
        }
    }

    publishState() {
        if (this.isMirrorMode) return;
        const state = {
            queue: this.orderList.map(order => ({
                uid: order.uid,
                uname: order.uname,
                song: order.song
            })),
            currentSong: this.currentSong,
            currentRequester: this.currentRequester,
            status: this.playerState || '等待播放',
            volume: this.volumePercent,
            settings: {
                order: window.__orderSettingsState || window.__lastSharedSettings?.order || null,
                login: window.__loginSettingsState || window.__lastSharedSettings?.login || null
            },
            updatedAt: Date.now()
        };
        try { localStorage.setItem(this.stateStorageKey, JSON.stringify(state)); } catch (_) { }
        this.stateChannel?.postMessage({ type: 'state', state });
        this.statePushQueue = this.statePushQueue
            .then(() => this.pushSharedState(state))
            .catch(() => {});
    }

    async pushSharedState(state) {
        const apiBase = `${window.API_CONFIG?.BASE_PATH || ''}${window.API_CONFIG?.bili_api || ''}`;
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId) return;
        try {
            await fetch(`${apiBase}/live/sync-state`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, state })
            });
        } catch (_) {
            // 不影响本地播放，服务器同步失败时继续使用本地同步机制。
        }
    }

    async pushSharedCommand(command) {
        const apiBase = `${window.API_CONFIG?.BASE_PATH || ''}${window.API_CONFIG?.bili_api || ''}`;
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId) return;
        try {
            await fetch(`${apiBase}/live/sync-command`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, command })
            });
        } catch (_) { }
    }

    async pullSharedCommands() {
        if (this.commandPulling) return;
        const apiBase = `${window.API_CONFIG?.BASE_PATH || ''}${window.API_CONFIG?.bili_api || ''}`;
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId || this.isMirrorMode) return;
        this.commandPulling = true;
        try {
            const url = `${apiBase}/live/sync-commands?room_id=${encodeURIComponent(roomId)}&after=${this.lastCommandId}&since=${this.commandStartedAt}`;
            const response = await fetch(url, { cache: 'no-store' });
            const result = await response.json();
            for (const command of result.data || []) {
                this.lastCommandId = Math.max(this.lastCommandId, Number(command.sequence) || 0);
                this.handleCommand(command);
            }
        } catch (_) { }
        finally {
            this.commandPulling = false;
        }
    }

    setVolume(value) {
        const volume = Math.max(0, Math.min(100, Number(value) || 0));
        this.volumePercent = volume;
        localStorage.setItem('playerVolume', String(volume));
        this.applyVolume(volume);
        if (this.isMirrorMode) this.sendCommand('volume', volume);
        else this.publishState();
    }

    applyVolume(value) {
        this.volumePercent = Math.max(0, Math.min(100, Number(value) || 0));
        this.audio.volume = this.volumePercent / 100;
        const slider = document.getElementById('volumeSlider');
        const output = document.getElementById('volumeValue');
        if (slider) slider.value = String(this.volumePercent);
        if (output) output.textContent = `${this.volumePercent}%`;
    }

    sendCommand(command, value) {
        const message = {
            type: 'command',
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            command,
            value
        };
        this.stateChannel?.postMessage(message);
        this.pushSharedCommand(message);
        if (!this.stateChannel && !window.API_CONFIG?.bili_api) publicMethod.pageAlert('未连接到 OBS 播放页面');
    }

    applySharedState(state) {
        if (!state) return;
        if (state.updatedAt && state.updatedAt < this.lastSharedStateAt) return;
        this.lastSharedStateAt = state.updatedAt || Date.now();
        this.orderList = Array.isArray(state.queue) ? state.queue : [];
        this.currentSong = state.currentSong || this.orderList[0]?.song || null;
        this.currentRequester = state.currentRequester || this.orderList[0]?.uname || '';
        if (state.volume != null) this.applyVolume(state.volume);
        if (state.settings) {
            window.__lastSharedSettings = state.settings;
            window.dispatchEvent(new CustomEvent('bilibili-ordersong-shared-settings', {
                detail: state.settings
            }));
        }
        this.renderQueue();
        this.updateNowPlaying(this.currentSong, this.currentRequester);
        this.updatePlayerState(state.status || '等待 OBS 播放');
    }

    renderQueue() {
        if (!this.elem_orderList) return;
        this.elem_orderList.innerHTML = '';
        this.elem_orderList.style.height = `${this.orderList.length * 40}px`;
        this.orderList.forEach((order, index) => {
            const tr = document.createElement('tr');
            [order.song?.sname || '', order.song?.sartist || '', order.uname || ''].forEach(value => {
                const td = document.createElement('td');
                td.textContent = value;
                tr.appendChild(td);
            });
            tr.style.top = `${40 + index * 40}px`;
            this.elem_orderList.appendChild(tr);
        });
        this.updateQueueView();
    }

    // 播放器添加事件监听
    addListener() {
        // 1. 开始播放事件
        this.audio.addEventListener("play", () => {
            let dot = document.getElementsByClassName('dot')[0];
            // 设置闪烁动画
            if (!dot.classList.contains("dot_blink")) {
                dot.classList.add("dot_blink");
            }
            this.updatePlayerState("播放中");
        });
        // 2. 暂停播放事件
        this.audio.addEventListener("pause", () => {
            let dot = document.getElementsByClassName('dot')[0];
            // 设置闪烁动画
            if (dot.classList.contains("dot_blink")) {
                dot.classList.remove("dot_blink");
            }
            this.updatePlayerState("已暂停");
        });
        // 3. 播放时间更新事件
        this.audio.addEventListener("timeupdate", () => {
            let progress = document.getElementsByClassName('progress_bar')[0];
            // 页面进度条实时修改
            const duration = Number(this.audio.duration);
            const progressWidth = progress?.parentElement?.clientWidth || 280;
            progress.style.width = duration > 0
                ? ((this.audio.currentTime / duration) * progressWidth) + "px"
                : "0px";
            // 超过歌曲限长则自动播放下一首
            if (orderConfiger.overLimitSkip > 0 && this.audio.currentTime > orderConfiger.overLimitSkip) {
                this.playNext();
            }
        });
        // 4. 播放结束事件
        this.audio.addEventListener("ended", () => {
            // 播放下一首歌曲
            this.playNext();
        });
        // 5. 播放失败事件
        this.audio.addEventListener("error", () => {
            this.updatePlayerState("播放错误");
            publicMethod.pageAlert("播放错误，即将播放下一首...");
            setTimeout(() => {
                // 播放下一首歌曲
                this.playNext();
            }, 6000);
        });
    }

    // 播放歌曲
    async play(song, requester = '') {

        this.currentSong = song;
        this.currentRequester = requester;
        this.updateNowPlaying(song, requester);
        this.publishState();

        // 根据平台查询歌曲链接
        const songurl = await musicServer.getServer(song.platform).getSongUrl(song.sid);

        if (!songurl) {
            publicMethod.pageAlert("获取歌曲链接失败，即将播放下一首...");
            // 清除切歌锁，允许下一首播放
            this.isSwitching = false;
            this._flushPending();
            return;
        }

        this.audio.src = songurl;

        /*----------------------------音量淡入-------------------------------*/
        if (this.playFadeIn) {
            clearInterval(this.playFadeIn);
            this.playFadeIn = null;
        }
        /*
            此处有两个注意点
            1. 此处若自增 0.1 会出现精度问题，0.1 + 0.2 不等于 0.3
            2. setInterval为全局函数，需要用箭头函数来保证this的指向
        */
        this.audio.volume = 0;
        this.playFadeIn = setInterval(() => {
            const targetVolume = this.volumePercent / 100;
            this.audio.volume = Math.min(targetVolume, this.audio.volume + 0.1);
            if (this.audio.volume >= targetVolume) {
                clearInterval(this.playFadeIn);
                this.playFadeIn = null;
            }
        }, 300);
        /*----------------------------音量淡入-------------------------------*/

        // 播放
        await this.audio.play().catch(err => {
            console.warn("播放失败，可能需要用户先与页面交互：", err.message);
            this.updatePlayerState("请点击启用声音");
        });

        // 歌曲开始播放后，清除切歌锁，检查待执行
        this.isSwitching = false;
        this._flushPending();
    }

    // 用户手动点击后解锁浏览器音频策略，并尝试恢复当前歌曲
    async unlockPlayback() {
        if (this.isMirrorMode) {
            this.sendCommand('unlockAudio');
            publicMethod.pageAlert("已请求 OBS 播放页面启用声音");
            return;
        }
        if (!this.audio.src) {
            publicMethod.pageAlert("当前还没有歌曲，请先点歌");
            return;
        }
        try {
            await this.audio.play();
            publicMethod.pageAlert("声音已启用");
        } catch (error) {
            console.warn("手动启用声音失败：", error);
            publicMethod.pageAlert("声音启用失败，请检查浏览器或 OBS 音频设置");
        }
    }

    async togglePlayback() {
        if (this.isMirrorMode) {
            this.sendCommand('toggle');
            return;
        }
        if (!this.audio.src) {
            publicMethod.pageAlert("当前还没有歌曲，请先点歌");
            return;
        }
        if (this.audio.paused) {
            await this.unlockPlayback();
        } else {
            this.audio.pause();
        }
    }

    updateNowPlaying(song, requester = '') {
        const name = document.getElementById('nowSong');
        const artist = document.getElementById('nowArtist');
        const requesterElement = document.getElementById('nowRequester');
        if (name) name.textContent = song?.sname || '等待点歌...';
        if (artist) artist.textContent = song?.sartist || '未知歌手';
        if (requesterElement) requesterElement.textContent = requester ? `点歌人：${requester}` : '';
    }

    updatePlayerState(state) {
        this.playerState = state;
        const status = document.getElementById('playerStatus');
        const toggle = document.getElementById('togglePlayBtn');
        if (status) status.textContent = state;
        if (toggle) toggle.textContent = state === '播放中' ? '暂停' : '播放';
        this.publishState();
    }

    updateQueueView() {
        const count = document.getElementById('queueCount');
        const empty = document.getElementById('emptyQueue');
        if (count) count.textContent = `${this.orderList.length} 首`;
        if (empty) empty.style.display = this.orderList.length ? 'none' : 'block';
    }

    // 播放下一首
    async playNext() {
        if (this.isMirrorMode) {
            this.sendCommand('next');
            return;
        }
        // 互斥锁：正在切歌时，标记为待执行而非丢弃
        if (this.isSwitching) {
            this.pendingNext = true;
            return;
        }
        this.isSwitching = true;

        // 停止当前播放，防止 ended/error 事件重复触发
        this.audio.pause();
        this.audio.removeAttribute('src');

        if (this.orderList.length > 0) {
            // 若点歌列表存在歌曲，则删除第一首
            this.orderList.shift();
            this.publishState();

            // 页面同步删除第一个点歌项
            const elem = this.elem_orderList.children[0];

            // 设置删除动画效果
            elem.style.animation = "fadeOut 1s forwards";

            // 延迟删除，等待动画完成
            setTimeout(() => {
                // 删除点歌项
                elem.remove();
                // 所有点歌项位置上移动一个单位
                for (let j = 0; j < this.elem_orderList.children.length; j++) {
                    const elem_other = this.elem_orderList.children[j];
                    elem_other.style.top = (elem_other.offsetTop - 40) + "px";
                }
                this.elem_orderList.style.height = (this.orderList.length * 40) + "px";
                this.updateQueueView();
            }, 1000);
        }

        // 若点歌列表还有歌曲，则直接播放第一首
        if (this.orderList.length) {
            await this.play(this.orderList[0].song, this.orderList[0].uname);
            return;
        }

        // 若点歌列表没有歌曲，则随机播放空闲歌单的歌曲            
        if (!this.idleSongList.length) {
            publicMethod.pageAlert("没有下一首可以放了>_<!");
            this.updatePlayerState("等待下一首");
            this.isSwitching = false;
            this._flushPending();
            return;
        }

        // 随机播放
        if (this.idleIndex == this.idleSongList.length - 1) {
            // 洗牌空闲歌单
            this.idleSongList = publicMethod.shuffle(this.idleSongList);
        }
        this.idleIndex = (++this.idleIndex) % this.idleSongList.length;

        // 将空闲歌单的歌曲添加到点歌列表中
        this.addOrder(this.idleSongList[this.idleIndex]);

        // 播放当前第一首歌曲
        await this.play(this.orderList[0].song, this.orderList[0].uname);
    }

    // 检查并执行待处理的切歌请求
    _flushPending() {
        if (this.pendingNext) {
            this.pendingNext = false;
            // 当前正在播放用户点的歌（uid != 0），ended 的 playNext 已处理，无需再切
            if (this.orderList.length > 0 && this.orderList[0].uid != 0) {
                return;
            }
            this.playNext();
        }
    }

    // 添加点歌对象
    addOrder(order) {
        if (this.isMirrorMode) return;
        // 检查点歌信息
        if (!this.checkOrder(order)) {
            return;
        }

        // 点歌成功，添加点歌信息到点歌列表中
        this.orderList.push(order);

        // 页面同步添加点歌项
        this.elem_orderList.style.height = (this.orderList.length * 40) + "px";
        let tr = document.createElement('tr');
        tr.innerHTML = `<td>${order.song.sname}</td>
                <td>${order.song.sartist}</td>
                <td>${order.uname}</td></td>`;
        tr.style.top = (40 + (this.elem_orderList.children.length - 1) * 40) + "px"
        tr.style.animation = "fadeIn 1s forwards";
            this.elem_orderList.appendChild(tr);
        this.updateQueueView();
        this.publishState();

        // 同时存储到配置项的历史用户列表、历史点歌列表中，忽略空闲歌单歌曲
        if (order.uid != 0) {
            orderConfiger.addUserHistory({
                uid: order.uid,
                uname: order.uname,
            });

            orderConfiger.addSongHistory({
                sid: order.song.sid,
                sname: order.song.sname,
            });
        }
    }

    // 检查点歌信息
    checkOrder(order) {
        // 查询用户是否被拉入黑名单
        for (let i = 0; i < orderConfiger.userBlackList.length; i++) {
            if (orderConfiger.userBlackList[i].uid == order.uid) {
                publicMethod.pageAlert("你已被加入暗杀名单!(▼へ▼メ)!");
                return false;
            }
        }

        // 用户点歌数是否已达上限
        if (this.orderList.filter(value => value.uid == order.uid).length >= orderConfiger.userMaxOrder) {
            publicMethod.pageAlert("你点太多啦，歇歇吧>_<!");
            return false;
        }

        // 全局点歌数是否已达上限
        if (this.orderList.length >= orderConfiger.globalMaxOrder) {
            publicMethod.pageAlert("我装不下更多的歌啦>_<!");
            return false;
        }

        // 查询歌曲是否被拉入黑名单
        for (let i = 0; i < orderConfiger.songBlackList.length; i++) {
            if (orderConfiger.songBlackList[i].sid == order.song.sid) {
                publicMethod.pageAlert("请不要乱点奇怪的歌!(▼ヘ▼#)");
                return false;
            }
        }

        // 判断该歌曲是否已在点歌列表
        if (this.orderList.some(value => value.song.sid == order.song.sid)) {
            publicMethod.pageAlert("已经点上啦!>_<!");
            return false;
        }

        // 该歌曲是否有歌曲时长限制，且歌曲时长是否超出规定时长
        if (orderConfiger.orderMaxDuration > 0 && order.song.duration > orderConfiger.orderMaxDuration) {
            publicMethod.pageAlert("你点的歌时太长啦!>_<");
            return false;
        }

        return true;
    }
}

export default new MusicPlayer();
