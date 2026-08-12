import orderConfiger from "./order-configer.js?v=20260810-41";
import publicMethod from "../utils/common.js?v=20260810-41";
import musicServer from "../services/musicServers/music-server.js?v=20260812-18";
import lyricService from "../services/lyric-service.js?v=20260812-1";

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

    // 播放请求序号，避免旧歌曲的异步链接请求晚返回后覆盖新歌。
    playbackRequestId = 0;
    errorNextTimer = null;
    overLimitTriggered = false;
    autoSkipCount = 0;

    // 当前播放歌曲，用于同步 H5 播放卡片
    currentSong = null;
    currentRequester = '';
    // audio.src 在切歌请求期间可能仍然是上一首，不能只比较 currentSong，
    // 否则 applySharedState 先覆盖 currentSong 后会误判为“同一首歌”。
    loadedAudioSongId = '';
    playerState = '等待播放';

    // livemode=false 页面作为 OBS 播放页的镜像，不再创建第二个播放器
    isMirrorMode = false;
    stateChannel = null;
    stateTimer = null;
    statePollTimer = null;
    statePulling = false;
    statePushQueue = Promise.resolve();
    lastSharedRevision = 0;
    lastQueueRevision = 0;
    commandPulling = false;
    lastSharedStateAt = 0;
    commandPollTimer = null;
    credentialsPollTimer = null;
    commandStartedAt = Date.now();
    lastCommandId = 0;
    handledCommandIds = new Set();
    volumePercent = 50;
    publisherId = '';
    publisherStartedAt = Date.now();
    publisherRetryTimer = null;
    publisherClaiming = false;
    requestedPublisher = false;
    credentialsPushTimer = null;
    ready = Promise.resolve();
    publisherClaimed = false;
    debug = false;
    audioUnlockRequired = false;
    sharedAudioUnlockRequired = false;
    remotePlayback = null;
    remotePlaybackReceivedAt = 0;
    progressAnimationFrame = 0;
    progressDragging = false;
    seekPreviewUntil = 0;
    lastSeekSubmittedAt = 0;
    lastSeekSubmittedValue = null;
    lyricRequestId = 0;
    lyricAbortController = null;
    lyricSongKey = '';
    lyricLines = [];
    currentLyricIndex = -2;

    constructor() {
        this.debug = this.getDebugMode();
        this.isMirrorMode = !this.getPageLiveMode();
        this.requestedPublisher = !this.isMirrorMode;
        const roomId = this.getPageRoomId() || 'default';
        if (!this.isMirrorMode) {
            this.publisherId = `publisher-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            this.publisherStartedAt = Date.now();
        }
        this.volumePercent = 50;
        this.applyVolume(this.volumePercent);
        this.ready = this.initStateSync();
        this.addListener();
        window.addEventListener('bilibili-display-settings-changed', () => {
            document.documentElement.style.setProperty('--lyrics-font-size', `${this.getDisplaySetting('lyricsFontSize', 22)}px`);
            this.currentLyricIndex = -2;
            this.renderLyricsAt(this.getPlaybackPositionMs());
            this.renderPlaybackProgress(this.getPlaybackPositionMs(), this.getPlaybackDurationMs());
        });
        window.addEventListener('bilibili-ordersong-settings-changed', event => {
            if (!this.isMirrorMode) {
                // 播放端租约确认前，禁止本地旧配置抢先覆盖服务端房间状态。
                if (this.publisherClaimed) this.publishState();
                return;
            }
            this.sendCommand('settings', {
                order: event.detail?.order || window.__orderSettingsState || null,
                login: event.detail?.login || window.__loginSettingsState || null
            });
        });
        this.updateQueueView();
        this.debugLog('播放器初始化', {
            roomId,
            mirrorMode: this.isMirrorMode,
            liveMode: !this.isMirrorMode,
            debug: this.debug
        });
        console.log("音乐播放器初始化完成");
    }

    getDebugMode() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        const value = new URLSearchParams(query).get('debug') || '';
        return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    }

    getDisplaySetting(key, fallback) {
        const value = window.__displaySettings?.[key];
        return value == null ? fallback : value;
    }

    songKey(song = this.currentSong) {
        if (!song?.sid) return '';
        return `${song.platform || 'wy'}:${song.sid}`;
    }

    formatPlaybackTime(ms) {
        const value = Number(ms);
        if (!Number.isFinite(value)) return '--:--';
        const totalSeconds = Math.max(0, Math.floor(value / 1000));
        const seconds = totalSeconds % 60;
        const minutes = Math.floor(totalSeconds / 60);
        if (minutes < 60) return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        const hours = Math.floor(minutes / 60);
        return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    getPlaybackPositionMs() {
        if (!this.isMirrorMode) return Math.max(0, Math.round((Number(this.audio.currentTime) || 0) * 1000));
        const playback = this.remotePlayback;
        if (!playback || playback.songKey !== this.songKey()) return 0;
        let positionMs = Math.max(0, Number(playback.positionMs) || 0);
        const sampledAt = Number(playback.sampledAt);
        const receivedAt = this.remotePlaybackReceivedAt || Date.now();
        const anchor = Number.isFinite(sampledAt) && Math.abs(Date.now() - sampledAt) <= 30_000
            ? sampledAt
            : receivedAt;
        if (!playback.paused && !playback.seeking && Number(playback.readyState) >= 3) {
            positionMs += Math.max(0, Date.now() - anchor);
        }
        const durationMs = Number(playback.durationMs) || 0;
        return durationMs > 0 ? Math.min(positionMs, durationMs) : positionMs;
    }

    getPlaybackDurationMs() {
        if (!this.isMirrorMode) {
            const duration = Number(this.audio.duration);
            return Number.isFinite(duration) && duration > 0
                ? Math.round(duration * 1000)
                : Math.max(0, Math.round((Number(this.currentSong?.duration) || 0) * 1000));
        }
        return Math.max(0, Number(this.remotePlayback?.durationMs) || 0);
    }

    renderPlaybackProgress(positionMs, durationMs, { interactive = true } = {}) {
        const root = document.getElementById('playbackProgress');
        if (!root) return;
        const duration = Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : 0;
        let position = Number.isFinite(Number(positionMs)) ? Math.max(0, Number(positionMs)) : 0;
        if (duration > 0) position = Math.min(position, duration);
        const current = document.getElementById('currentTimeText');
        const total = document.getElementById('durationText');
        const slider = document.getElementById('progressSlider');
        const buffered = document.getElementById('progressBuffered');
        if (current) current.textContent = this.formatPlaybackTime(position);
        if (total) total.textContent = duration > 0 ? this.formatPlaybackTime(duration) : '--:--';
        root.style.setProperty('--played-ratio', String(duration > 0 ? Math.min(1, position / duration) : 0));
        if (slider && !this.progressDragging && Date.now() >= this.seekPreviewUntil) {
            slider.max = String(duration);
            slider.value = String(Math.min(position, duration || position));
        }
        if (slider) {
            slider.disabled = !this.currentSong || duration <= 0 || !interactive ||
                !Boolean(this.getDisplaySetting('progressSeekEnabled', true));
        }
        if (buffered) {
            let bufferedRatio = 0;
            if (!this.isMirrorMode && duration > 0 && this.audio.buffered?.length) {
                try { bufferedRatio = Math.min(1, this.audio.buffered.end(this.audio.buffered.length - 1) * 1000 / duration); } catch (_) { /* media changed */ }
            }
            buffered.style.transform = `scaleX(${bufferedRatio})`;
        }
    }

    startProgressAnimation() {
        if (this.progressAnimationFrame) return;
        const frame = () => {
            this.progressAnimationFrame = requestAnimationFrame(frame);
            const position = this.getPlaybackPositionMs();
            this.renderPlaybackProgress(position, this.getPlaybackDurationMs(), { interactive: true });
            this.renderLyricsAt(position);
            if (this.isMirrorMode ? this.remotePlayback?.paused || this.remotePlayback?.seeking : this.audio.paused) {
                this.stopProgressAnimation();
            }
        };
        this.progressAnimationFrame = requestAnimationFrame(frame);
    }

    stopProgressAnimation() {
        if (this.progressAnimationFrame) cancelAnimationFrame(this.progressAnimationFrame);
        this.progressAnimationFrame = 0;
    }

    async commitSeek(positionMs) {
        const duration = this.getPlaybackDurationMs();
        const target = Math.max(0, Math.min(duration > 0 ? duration : Number(positionMs) || 0, Number(positionMs) || 0));
        if (this.lastSeekSubmittedValue === target && Date.now() - this.lastSeekSubmittedAt < 250) return null;
        this.lastSeekSubmittedValue = target;
        this.lastSeekSubmittedAt = Date.now();
        this.progressDragging = false;
        this.seekPreviewUntil = Date.now() + 2000;
        this.renderPlaybackProgress(target, duration, { interactive: true });
        this.renderLyricsAt(target);
        if (this.isMirrorMode) {
            const result = await this.sendCommand('seek', {
                positionMs: Math.round(target),
                expectedSongKey: this.songKey()
            });
            if (!result?.ok && result?.result?.reason) publicMethod.pageAlert('跳转失败：' + result.result.reason);
            return result;
        }
        return this.executeSeek({ positionMs: target, expectedSongKey: this.songKey() });
    }

    executeSeek(value = {}) {
        if (this.isMirrorMode || !this.currentSong || value.expectedSongKey !== this.songKey()) return false;
        const duration = Number(this.audio.duration);
        if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(Number(value.positionMs))) return false;
        const target = Math.max(0, Math.min(duration, Number(value.positionMs) / 1000));
        try {
            this.audio.currentTime = target;
            this.renderPlaybackProgress(target * 1000, duration * 1000, { interactive: true });
            this.renderLyricsAt(target * 1000);
            this.publishState();
            return true;
        } catch (_) {
            return false;
        }
    }

    setLyricsState(status, payload = {}) {
        const panel = document.getElementById('lyricsPanel');
        const statusElement = document.getElementById('lyricsStatus');
        if (!panel) return;
        const enabled = Boolean(this.getDisplaySetting('lyricsEnabled', true));
        panel.hidden = !enabled || !this.currentSong || status === 'hidden';
        panel.dataset.state = status;
        const labels = {
            loading: '正在获取歌词',
            instrumental: '纯音乐，请欣赏',
            unsupported: '暂不支持该平台歌词',
            empty: '暂无歌词',
            error: '歌词获取失败'
        };
        if (statusElement) {
            statusElement.textContent = payload.message || labels[status] || '';
            statusElement.hidden = !labels[status] && !payload.message;
        }
    }

    resetLyrics({ loading = false } = {}) {
        this.lyricLines = [];
        this.currentLyricIndex = -2;
        this.lyricSongKey = loading ? this.songKey() : '';
        ['lyricsPrevious', 'lyricsCurrent', 'lyricsTranslation', 'lyricsNext'].forEach(id => {
            const element = document.getElementById(id);
            const textElement = element?.querySelector('.lyricsText') || element;
            if (textElement) textElement.textContent = '';
            element?.classList.remove('lyricsMarquee');
        });
        const translation = document.getElementById('lyricsTranslation');
        if (translation) translation.hidden = true;
        this.setLyricsState(loading ? 'loading' : 'hidden');
    }

    async loadLyricsForSong(song) {
        const requestId = ++this.lyricRequestId;
        this.lyricAbortController?.abort();
        this.lyricAbortController = typeof AbortController === 'function' ? new AbortController() : null;
        const key = this.songKey(song);
        this.lyricSongKey = key;
        this.resetLyrics({ loading: true });
        if (!song) {
            this.resetLyrics();
            return;
        }
        try {
            const result = await lyricService.load(song, { signal: this.lyricAbortController?.signal });
            if (requestId !== this.lyricRequestId || this.songKey() !== key) return;
            this.lyricLines = Array.isArray(result.lines) ? result.lines : [];
            this.currentLyricIndex = -2;
            this.setLyricsState(result.status || (result.noLyrics ? 'empty' : 'ready'));
            this.renderLyricsAt(this.getPlaybackPositionMs());
        } catch (error) {
            if (requestId !== this.lyricRequestId || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') return;
            this.setLyricsState('error');
        }
    }

    renderLyricsAt(positionMs) {
        if (!this.currentSong || this.lyricSongKey !== this.songKey() || !this.lyricLines.length) return;
        const effectiveTime = Number(positionMs || 0) + Number(this.getDisplaySetting('lyricsOffsetMs', 0) || 0);
        const index = lyricService.findLineIndex(this.lyricLines, effectiveTime);
        if (index === this.currentLyricIndex && !this.progressDragging) return;
        this.currentLyricIndex = index;
        const previous = this.lyricLines[index - 1];
        const current = this.lyricLines[index];
        const next = this.lyricLines[index + 1];
        const overlayLineCount = Math.max(0, Math.min(3, Math.trunc(Number(this.getDisplaySetting('lyricsOverlayLines', 1)) || 0)));
        const setText = (id, value) => {
            const element = document.getElementById(id);
            const textElement = element?.querySelector('.lyricsText') || element;
            if (textElement) textElement.textContent = value || '';
        };
        const renderStack = (id, items) => {
            const element = document.getElementById(id);
            if (!element) return;
            const values = items.filter(Boolean);
            element.replaceChildren();
            values.forEach(item => {
                const line = document.createElement('div');
                line.className = 'lyricsStackLine';
                const text = document.createElement('span');
                text.className = 'lyricsText';
                text.textContent = item.text || '';
                line.appendChild(text);
                element.appendChild(line);
            });
            element.hidden = values.length === 0;
        };
        if (this.isLyricOverlay()) {
            // 第一条歌词开始前 index 为 -1，不能把 slice 的结束位置传成 -1，
            // 否则会渲染出除最后一条之外的整份歌词。
            const previousLines = index > 0
                ? this.lyricLines.slice(Math.max(0, index - overlayLineCount), index)
                : [];
            const nextStart = index >= 0 ? index + 1 : 0;
            renderStack('lyricsPrevious', previousLines);
            renderStack('lyricsNext', this.lyricLines.slice(nextStart, nextStart + overlayLineCount));
        } else {
            const previousElement = document.getElementById('lyricsPrevious');
            const nextElement = document.getElementById('lyricsNext');
            if (previousElement) previousElement.hidden = false;
            if (nextElement) nextElement.hidden = false;
            setText('lyricsPrevious', previous?.text);
            setText('lyricsNext', next?.text);
        }
        setText('lyricsCurrent', current?.text);
        const translation = document.getElementById('lyricsTranslation');
        if (translation) {
            const textElement = translation.querySelector('.lyricsText') || translation;
            textElement.textContent = current?.translation || '';
            translation.hidden = !Boolean(this.getDisplaySetting('lyricsTranslation', true)) || !current?.translation;
        }
        this.refreshLyricMarquees();
    }

    refreshLyricMarquees() {
        const update = container => {
            const textElement = container?.querySelector('.lyricsText');
            if (!container || !textElement) return;
            container.classList.remove('lyricsMarquee');
            container.style.removeProperty('--lyrics-marquee-shift');
            container.style.removeProperty('--lyrics-marquee-duration');
            if (container.hidden || !textElement.textContent.trim()) return;
            const overflow = textElement.scrollWidth - container.clientWidth;
            if (overflow <= 1) return;
            container.classList.add('lyricsMarquee');
            container.style.setProperty('--lyrics-marquee-shift', `${-overflow}px`);
            // 以约 85px/s 的速度滚动；长歌词不再被过高的时长上限拖慢。
            container.style.setProperty('--lyrics-marquee-duration', `${Math.max(5, Math.min(16, overflow / 85 + 1.8))}s`);
        };
        const updateContainer = id => {
            const container = document.getElementById(id);
            if (!container) return;
            const stackLines = [...container.querySelectorAll('.lyricsStackLine')];
            (stackLines.length ? stackLines : [container]).forEach(update);
        };
        ['lyricsPrevious', 'lyricsCurrent', 'lyricsTranslation', 'lyricsNext'].forEach(updateContainer);
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
            ['lyricsPrevious', 'lyricsCurrent', 'lyricsTranslation', 'lyricsNext'].forEach(updateContainer);
        });
    }

    debugLog(label, value) {
        if (!this.debug) return;
        if (typeof value === 'undefined') console.debug(`[MusicPlayer][debug] ${label}`);
        else console.debug(`[MusicPlayer][debug] ${label}`, value);
    }

    describeAudioUrl(url) {
        if (!url) return '';
        try {
            const parsed = new URL(url, window.location.href);
            return `${parsed.origin}${parsed.pathname}`;
        } catch (_) {
            return '[无法解析的音频地址]';
        }
    }

    getPageRole() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        return (new URLSearchParams(query).get('source') || '').toLowerCase();
    }

    isLyricOverlay() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        return ['1', 'true', 'yes', 'on'].includes((new URLSearchParams(query).get('lyric') || '').toLowerCase());
    }

    getPageLiveMode() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        const params = new URLSearchParams(query);
        if (params.get('settings') === '1') return false;
        if (['1', 'true', 'yes', 'on'].includes((params.get('lyric') || '').toLowerCase())) return false;
        if (['monitor', 'control', 'preview'].includes(this.getPageRole())) return false;
        return !['0', 'false', 'no', 'off'].includes((params.get('livemode') || 'true').toLowerCase());
    }

    getPageRoomId() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        return new URLSearchParams(query).get('roomid') || new URLSearchParams(query).get('room_id') || '';
    }

    getSyncApiBase() {
        const configured = publicMethod.resolveApiBase(window.API_CONFIG?.bili_api);
        if (configured) return configured;
        // 直播姬内置 WebView 可能执行配置脚本较晚，使用当前页面路径兜底。
        return new URL('./bili-api', window.location.href).pathname.replace(/\/$/, '');
    }

    async initStateSync() {
        const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        if (new URLSearchParams(query).get('settings') === '1') return;
        if (typeof BroadcastChannel === 'function') {
            this.stateChannel = new BroadcastChannel(`bilibili-ordersong-state:${this.getPageRoomId() || 'default'}`);
            this.stateChannel.onmessage = event => this.handleStateMessage(event.data);
        }
        window.addEventListener('storage', event => {
            // 播放状态只接受服务端同步，不能让控制页的旧 localStorage 覆盖 OBS 状态。
        });
        if (this.isMirrorMode) {
            this.pushSharedCredentials();
            await this.startMirrorSync();
        } else {
            const claimResult = await this.claimPublisher();
            if (!claimResult.claimed) {
                this.becomeMirrorMode(claimResult.state, claimResult.reason);
                return false;
            }
            this.publisherClaimed = true;
            if (claimResult.state) this.applySharedState(claimResult.state);
            await this.pullSharedCredentials();
            this.credentialsPollTimer = setInterval(() => this.pullSharedCredentials(), 3000);
            if (claimResult.state?.currentSong) {
                await this.playCanonicalState(claimResult.state, 'publisher-start');
            }
            this.publishState();
            this.stateTimer = setInterval(() => this.publishState(), 1000);
            this.commandPollTimer = setInterval(() => this.pullSharedCommands(), 500);
        }
        return true;
    }

    async startMirrorSync() {
        await this.requestSharedState();
        if (!this.statePollTimer) {
            this.statePollTimer = setInterval(() => this.pullSharedState(), 1000);
        }
        // 控制页可能在后端启动前就已打开，服务恢复后要重新推送本地登录态。
        if (!this.requestedPublisher && !this.credentialsPushTimer) {
            this.credentialsPushTimer = setInterval(() => this.pushSharedCredentials(), 3000);
        }
    }

    async claimPublisher() {
        const apiBase = this.getSyncApiBase();
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId) return { claimed: true };
        try {
            const response = await fetch(`${apiBase}/live/sync-claim`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, publisherId: this.publisherId }),
                cache: 'no-store'
            });
            const result = await response.json();
            this.debugLog('播放端租约结果', {
                claimed: result.claimed,
                ignored: result.ignored,
                reason: result.reason,
                publisherId: result.data?.publisherId
            });
            return {
                claimed: result.code === 0 && result.claimed !== false,
                state: result.data || null,
                reason: result.reason || 'publisher-locked'
            };
        } catch (error) {
            // 服务端同步不可用时保留本地播放能力，恢复连接后再通过心跳接管。
            this.debugLog('播放端租约请求失败，暂按播放端运行', {
                name: error.name,
                message: error.message
            });
            return { claimed: true, unavailable: true };
        }
    }

    becomeMirrorMode(state = null, reason = 'publisher-locked') {
        if (this.isMirrorMode) return;
        this.isMirrorMode = true;
        this.publisherClaimed = false;
        if (this.stateTimer) clearInterval(this.stateTimer);
        if (this.commandPollTimer) clearInterval(this.commandPollTimer);
        if (this.credentialsPollTimer) clearInterval(this.credentialsPollTimer);
        if (this.credentialsPushTimer) clearInterval(this.credentialsPushTimer);
        this.stateTimer = null;
        this.commandPollTimer = null;
        this.credentialsPollTimer = null;
        this.credentialsPushTimer = null;
        this.idleSongList = [];
        this.idleIndex = -1;
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.loadedAudioSongId = '';
        this.debugLog('当前页面降级为监控/控制端', { reason, publisherId: state?.publisherId });
        if (state) this.applySharedState(state);
        this.startMirrorSync();
        this.startPublisherRetry();
    }

    startPublisherRetry() {
        if (!this.requestedPublisher || this.publisherRetryTimer) return;
        this.publisherRetryTimer = setInterval(() => this.tryReclaimPublisher(), 3000);
    }

    async tryReclaimPublisher() {
        if (!this.requestedPublisher || !this.isMirrorMode || this.publisherClaiming) return;
        this.publisherClaiming = true;
        this.publisherId = `publisher-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this.publisherStartedAt = Date.now();
        try {
            const claimResult = await this.claimPublisher();
            if (!claimResult.claimed || claimResult.unavailable) return;

            this.isMirrorMode = false;
            this.publisherClaimed = true;
            if (this.credentialsPushTimer) clearInterval(this.credentialsPushTimer);
            this.credentialsPushTimer = null;
            if (this.statePollTimer) clearInterval(this.statePollTimer);
            this.statePollTimer = null;
            if (claimResult.state) this.applySharedState(claimResult.state);
            await this.pullSharedCredentials();
            if (claimResult.state?.currentSong) {
                await this.playCanonicalState(claimResult.state, 'publisher-reclaim');
            }
            if (!this.credentialsPollTimer) {
                this.credentialsPollTimer = setInterval(() => this.pullSharedCredentials(), 3000);
            }
            this.publishState();
            this.stateTimer = setInterval(() => this.publishState(), 1000);
            this.commandPollTimer = setInterval(() => this.pullSharedCommands(), 500);
            this.debugLog('已重新抢回 OBS 播放端租约', { publisherId: this.publisherId });
            window.dispatchEvent(new CustomEvent('bilibili-ordersong-publisher-claimed'));
            clearInterval(this.publisherRetryTimer);
            this.publisherRetryTimer = null;
        } finally {
            this.publisherClaiming = false;
        }
    }

    async requestSharedState() {
        await this.pullSharedState();
    }

    async pullSharedState() {
        if (this.statePulling) return;
        const apiBase = this.getSyncApiBase();
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId) return;
        this.statePulling = true;
        try {
            const response = await fetch(`${apiBase}/live/sync-state?room_id=${encodeURIComponent(roomId)}`, {
                cache: 'no-store'
            });
            const result = await response.json();
            if (result.code === 0 && result.data) {
                // 服务端是唯一状态源。新的 OBS 播放端接管房间后，控制页必须
                // 接受它的新 publisherId，不能被旧 localStorage 卡住。
                this.applySharedState(result.data);
            }
        } catch (_) {
            // 服务端暂时不可用时保留当前画面，恢复连接后由下一次轮询更新。
        } finally {
            this.statePulling = false;
        }
    }

    async fetchCanonicalState() {
        const apiBase = this.getSyncApiBase();
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId) return null;
        try {
            const response = await fetch(`${apiBase}/live/sync-state?room_id=${encodeURIComponent(roomId)}`, {
                cache: 'no-store'
            });
            const result = await response.json();
            return result.code === 0 ? result.data || null : null;
        } catch (_) {
            return null;
        }
    }

    async pushSharedCredentials() {
        const apiBase = this.getSyncApiBase();
        const roomId = this.getPageRoomId();
        const cookie = musicServer.getServer('wy')?.cookie;
        if (!apiBase || !roomId || typeof cookie !== 'string' || !cookie.trim()) return false;
        try {
            const response = await fetch(`${apiBase}/live/sync-credentials`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, netease_cookie: cookie }),
                cache: 'no-store'
            });
            const result = await response.json();
            this.debugLog('网易云登录态已同步', { hasCookie: Boolean(result.data?.hasNeteaseCookie) });
            return response.ok && result.code === 0;
        } catch (error) {
            this.debugLog('网易云登录态同步失败', { message: error.message });
            return false;
        }
    }

    async pullSharedCredentials() {
        const apiBase = this.getSyncApiBase();
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId) return false;
        try {
            const response = await fetch(`${apiBase}/live/sync-credentials?room_id=${encodeURIComponent(roomId)}`, {
                cache: 'no-store'
            });
            const result = await response.json();
            if (result.code !== 0 || !result.data?.hasNeteaseCookie) return false;
            this.debugLog('已接收共享网易云登录态', { hasCookie: true });
            return true;
        } catch (error) {
            this.debugLog('读取共享网易云登录态失败', { message: error.message });
            return false;
        }
    }

    handleStateMessage(message) {
        if (!message) return;
        if (message.type === 'request-state' && !this.isMirrorMode) {
            this.publishState();
        } else if (message.type === 'command' && !this.isMirrorMode) {
            // 命令必须等后端回填 canonical state 后再执行，不能直接处理
            // BroadcastChannel 的原始消息，否则会出现“先本地播放、后又被旧状态覆盖”。
            if (message.sequence) this.handleCommand(message);
        }
    }

    async handleCommand(message) {
        if (!message || (message.id && this.handledCommandIds.has(message.id))) return;
        this.debugLog('OBS 收到控制指令', {
            id: message.id,
            command: message.command,
            value: message.command === 'volume' ? message.value : undefined,
            sequence: message.sequence,
            source: message.sequence ? 'http-poll' : 'broadcast-channel'
        });
        if (message.id) {
            this.handledCommandIds.add(message.id);
            if (this.handledCommandIds.size > 100) {
                this.handledCommandIds.delete(this.handledCommandIds.values().next().value);
            }
        }
        let canonicalState = message.state || null;
        if (!canonicalState || (message.stateRevision &&
            Number(canonicalState.stateRevision || 0) < Number(message.stateRevision))) {
            canonicalState = await this.fetchCanonicalState();
        }
        if (canonicalState) this.applySharedState(canonicalState);
        if (this.isMirrorMode) return;
        if (['next', 'addOrder', 'loadSongList', 'play'].includes(message.command)) {
            this.playCanonicalState(canonicalState, message.command);
        }
        if (message.command === 'toggle') {
            if (!this.audio.src && canonicalState?.currentSong) {
                this.playCanonicalState(canonicalState, 'toggle');
            } else if (this.audio.paused) {
                this.unlockPlayback();
            } else {
                this.audio.pause();
            }
        }
        if (message.command === 'pause') this.audio.pause();
        if (message.command === 'volume') this.applyVolume(canonicalState?.volume ?? message.value);
        if (message.command === 'seek') this.executeSeek(message.value);
        if (message.command === 'unlockAudio') this.unlockPlayback();
        if (message.command === 'settings' && message.value) {
            window.__lastSharedSettings = message.value;
            window.dispatchEvent(new CustomEvent('bilibili-ordersong-shared-settings', {
                detail: message.value
            }));
        }
    }

    async playCanonicalState(state, reason = 'state') {
        if (this.isMirrorMode) return;
        const song = state?.currentSong || this.currentSong;
        if (!song) {
            this.stopProgressAnimation();
            this.remotePlayback = null;
            this.resetLyrics();
            this.renderPlaybackProgress(0, 0, { interactive: false });
            this.audio.pause();
            this.audio.removeAttribute('src');
            this.loadedAudioSongId = '';
            this.currentSong = null;
            this.currentRequester = '';
            this.updateNowPlaying(null, '');
            this.updatePlayerState(state?.status || '等待点歌');
            return;
        }
        const sameSong = this.loadedAudioSongId === this.songKey(song) && Boolean(this.audio.src);
        if (!sameSong) {
            await this.play(song, state?.currentRequester || '');
            return;
        }
        if (reason === 'toggle' || reason === 'play') {
            if (this.audio.paused) await this.unlockPlayback();
        }
    }

    publishState() {
        if (this.isMirrorMode) return;
        const state = {
            queue: this.orderList.map(order => ({
                orderId: order.orderId,
                uid: order.uid,
                uname: order.uname,
                song: order.song,
                requestedAt: order.requestedAt,
                source: order.source
            })),
            currentSong: this.currentSong,
            currentRequester: this.currentRequester,
            status: this.playerState || '等待播放',
            volume: this.volumePercent,
            songListId: window.__sharedSongListId || window.__loginSettingsState?.songListId || '',
            idleSongList: this.idleSongList.map(order => ({
                orderId: order.orderId,
                uid: 0,
                uname: '空闲歌单',
                song: order.song || order,
                requestedAt: order.requestedAt,
                source: 'idle'
            })),
            idleIndex: this.idleIndex,
            idleSongCount: this.idleSongList.length,
            audioUnlockRequired: this.audioUnlockRequired,
            playback: {
                songKey: this.songKey(),
                positionMs: Math.max(0, Math.round((Number(this.audio.currentTime) || 0) * 1000)),
                durationMs: Number.isFinite(this.audio.duration)
                    ? Math.max(0, Math.round(this.audio.duration * 1000))
                    : Math.max(0, Math.round((Number(this.currentSong?.duration) || 0) * 1000)),
                paused: this.audio.paused,
                seeking: this.audio.seeking,
                readyState: this.audio.readyState,
                sampledAt: Date.now()
            },
            queueRevision: this.lastQueueRevision,
            settings: {
                order: window.__orderSettingsState || window.__lastSharedSettings?.order || null,
                login: window.__loginSettingsState || window.__lastSharedSettings?.login || null
            },
            publisherId: this.publisherId,
            publisherStartedAt: this.publisherStartedAt,
            updatedAt: Date.now()
        };
        this.statePushQueue = this.statePushQueue
            .then(() => this.pushSharedState(state))
            .catch(() => {});
    }

    async pushSharedState(state) {
        const apiBase = this.getSyncApiBase();
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId) return;
        try {
            const response = await fetch(`${apiBase}/live/sync-state`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, state })
            });
            const result = await response.json();
            this.debugLog('播放状态同步响应', {
                ignored: result.ignored,
                reason: result.reason,
                publisherId: result.data?.publisherId
            });
            if (result.ignored && result.reason === 'publisher-locked') {
                this.becomeMirrorMode(result.data, result.reason);
            }
        } catch (_) {
            // 不影响本地播放，服务器恢复后由下一次心跳继续同步。
        }
    }

    async pushSharedCommand(command) {
        const apiBase = this.getSyncApiBase();
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId) {
            this.debugLog('控制指令未发送：缺少同步地址或房间号', { apiBase, roomId, command: command.command });
            return { ok: false, reason: 'missing-sync-config' };
        }
        const startedAt = Date.now();
        this.debugLog('发送控制指令 HTTP 请求', {
            method: 'POST',
            url: `${apiBase}/live/sync-command`,
            roomId,
            command: command.command,
            commandId: command.id
        });
        try {
            const response = await fetch(`${apiBase}/live/sync-command`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, command })
            });
            const result = await response.json().catch(() => null);
            const ok = response.ok && result?.code === 0;
            this.debugLog('控制指令 HTTP 响应', {
                command: command.command,
                commandId: command.id,
                status: response.status,
                ok,
                elapsedMs: Date.now() - startedAt,
                result
            });
            // 控制页发送点歌/切歌后，不能只等待下一轮轮询刷新界面。
            // 后端返回的 data 是已经应用命令后的权威队列，立即应用它可以避免
            // 控制页短暂显示旧队列，也能覆盖部分 WebView 不稳定轮询的情况。
            if (ok && this.isMirrorMode && result?.data) {
                this.applySharedState(result.data);
            }
            return { ok, status: response.status, result, state: result?.data || null };
        } catch (error) {
            this.debugLog('控制指令 HTTP 请求失败', {
                command: command.command,
                commandId: command.id,
                elapsedMs: Date.now() - startedAt,
                message: error.message
            });
            return { ok: false, reason: error.message };
        }
    }

    async pullSharedCommands() {
        if (this.commandPulling) return;
        const apiBase = this.getSyncApiBase();
        const roomId = this.getPageRoomId();
        if (!apiBase || !roomId || this.isMirrorMode) return;
        this.commandPulling = true;
        try {
            const url = `${apiBase}/live/sync-commands?room_id=${encodeURIComponent(roomId)}&after=${this.lastCommandId}&since=${this.commandStartedAt}`;
            const response = await fetch(url, { cache: 'no-store' });
            const result = await response.json();
            for (const command of result.data || []) {
                this.lastCommandId = Math.max(this.lastCommandId, Number(command.sequence) || 0);
                await this.handleCommand(command);
            }
        } catch (_) { }
        finally {
            this.commandPulling = false;
        }
    }

    setVolume(value) {
        const volume = Math.max(0, Math.min(100, Number(value) || 0));
        this.volumePercent = volume;
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
        this.debugLog('发送控制指令', {
            id: message.id,
            command,
            value: command === 'volume' ? value : undefined,
            roomId: this.getPageRoomId(),
            broadcastChannel: Boolean(this.stateChannel)
        });
        this.stateChannel?.postMessage(message);
        const result = this.pushSharedCommand(message);
        if (!this.stateChannel && !window.API_CONFIG?.bili_api) publicMethod.pageAlert('未连接到 OBS 播放页面');
        return result;
    }

    applySharedState(state) {
        if (!state) return;
        if (state.stateRevision && state.stateRevision < this.lastSharedRevision) return;
        if (state.updatedAt && state.updatedAt < this.lastSharedStateAt) return;
        if (state.stateRevision) this.lastSharedRevision = state.stateRevision;
        if (state.queueRevision != null) this.lastQueueRevision = Number(state.queueRevision) || 0;
        this.lastSharedStateAt = state.updatedAt || Date.now();
        this.orderList = Array.isArray(state.queue)
            ? state.queue.map(order => this.normalizeQueueOrder(order)).filter(Boolean)
            : [];
        this.currentSong = state.currentSong || this.orderList[0]?.song || null;
        this.currentRequester = state.currentRequester || this.orderList[0]?.uname || '';
        const previousSongKey = this.remotePlayback?.songKey || this.lyricSongKey;
        this.remotePlayback = state.playback && typeof state.playback === 'object' ? state.playback : null;
        this.remotePlaybackReceivedAt = Date.now();
        if (this.remotePlayback?.songKey === this.songKey() &&
            this.lastSeekSubmittedValue != null && Date.now() - this.lastSeekSubmittedAt > 250) {
            this.lastSeekSubmittedValue = null;
        }
        if (previousSongKey !== this.songKey()) {
            this.seekPreviewUntil = 0;
            this.progressDragging = false;
            this.renderPlaybackProgress(0, 0, { interactive: false });
            this.loadLyricsForSong(this.currentSong);
        }
        if (typeof state.songListId === 'string' && state.songListId) {
            window.__sharedSongListId = state.songListId;
        }
        if (Array.isArray(state.idleSongList)) {
            this.idleSongList = state.idleSongList;
            this.idleIndex = Number.isInteger(Number(state.idleIndex)) ? Number(state.idleIndex) : -1;
        }
        const audioUnlockRequired = Boolean(state.audioUnlockRequired);
        if (this.isMirrorMode && audioUnlockRequired && !this.sharedAudioUnlockRequired) {
            publicMethod.pageAlert('OBS 播放页被浏览器阻止自动播放，请在 OBS 播放页点击一次启用声音');
        }
        this.sharedAudioUnlockRequired = audioUnlockRequired;
        if (state.volume != null) this.applyVolume(state.volume);
        if (state.settings || state.songListId) {
            const sharedSettings = state.settings || {};
            const sharedLogin = {
                ...(sharedSettings.login || {}),
                ...(state.songListId ? { songListId: state.songListId } : {})
            };
            window.__lastSharedSettings = {
                ...sharedSettings,
                login: Object.keys(sharedLogin).length ? sharedLogin : null
            };
            window.dispatchEvent(new CustomEvent('bilibili-ordersong-shared-settings', {
                detail: window.__lastSharedSettings
            }));
        }
        this.renderQueue();
        this.updateNowPlaying(this.currentSong, this.currentRequester);
        this.updatePlayerState(state.status || '等待 OBS 播放');
        this.renderPlaybackProgress(this.getPlaybackPositionMs(), this.getPlaybackDurationMs());
        this.renderLyricsAt(this.getPlaybackPositionMs());
        if (this.isMirrorMode && this.remotePlayback && !this.remotePlayback.paused && !this.remotePlayback.seeking) this.startProgressAnimation();
        else if (this.isMirrorMode) this.stopProgressAnimation();
        window.dispatchEvent(new CustomEvent('damuku-room-state', { detail: state }));
    }

    getQueueDisplayList() {
        const displayList = Array.isArray(this.orderList)
            ? this.orderList.map(order => order?.uid == 0
                ? { ...order, uname: '空闲歌单' }
                : order)
            : [];

        // 队列严格按服务端 queue 顺序展示，空闲歌单只在队列确实为空时做最后兜底；
        // 不能根据 currentSong 重新插入项目，否则切歌同步期间会改变点歌顺序。
        if (displayList.length === 0) {
            const idleOrder = this.idleSongList?.[this.idleIndex];
            const song = idleOrder?.song || idleOrder ||
                (this.currentRequester === '空闲歌单' ? this.currentSong : null);
            if (song?.sid) {
                displayList.push({
                    uid: 0,
                    uname: '空闲歌单',
                    song
                });
            }
        }
        return displayList;
    }

    normalizeQueueOrder(order) {
        if (!order || typeof order !== 'object') return null;
        const song = order.song || order;
        if (!song || song.sid == null) return null;
        return {
            orderId: String(order.orderId || ''),
            uid: Number(order.uid) || 0,
            uname: String(order.uname || (Number(order.uid) === 0 ? '空闲歌单' : '')),
            song
        };
    }

    renderQueue() {
        if (!this.elem_orderList) return;
        const displayList = this.getQueueDisplayList();
        this.elem_orderList.innerHTML = '';
        this.elem_orderList.style.height = `${displayList.length * 40}px`;
        displayList.forEach((order, index) => {
            const tr = document.createElement('tr');
            [order.song?.sname || '', order.song?.sartist || '', order.uname || ''].forEach(value => {
                const td = document.createElement('td');
                td.textContent = value;
                tr.appendChild(td);
            });
            // tbody 已经紧跟在表头后面，首行从 0 开始；再加 40px 会让
            // 只有一首歌时整行落到 tbody 可视区域之外。
            tr.style.top = `${index * 40}px`;
            this.elem_orderList.appendChild(tr);
        });
        this.updateQueueView();
    }

    // 播放器添加事件监听
    addListener() {
        // 1. 开始播放事件
        this.audio.addEventListener("play", () => {
            this.startProgressAnimation();
            this.updatePlayerState("播放中");
            this.publishState();
            this.debugLog('音频 play 事件', {
                paused: this.audio.paused,
                muted: this.audio.muted,
                volume: this.audio.volume,
                readyState: this.audio.readyState,
                networkState: this.audio.networkState
            });
        });
        // 2. 暂停播放事件
        this.audio.addEventListener("pause", () => {
            this.stopProgressAnimation();
            this.renderPlaybackProgress(this.getPlaybackPositionMs(), this.getPlaybackDurationMs());
            this.renderLyricsAt(this.getPlaybackPositionMs());
            this.updatePlayerState("已暂停");
            this.publishState();
            this.debugLog('音频 pause 事件', {
                currentTime: this.audio.currentTime,
                readyState: this.audio.readyState
            });
        });
        this.audio.addEventListener("loadstart", () => this.debugLog('音频开始加载', {
            src: this.describeAudioUrl(this.audio.currentSrc || this.audio.src)
        }));
        this.audio.addEventListener("loadedmetadata", () => {
            this.renderPlaybackProgress(this.getPlaybackPositionMs(), this.getPlaybackDurationMs());
            this.publishState();
            this.debugLog('音频元数据已加载', { duration: this.audio.duration, readyState: this.audio.readyState });
        });
        this.audio.addEventListener("canplay", () => this.debugLog('音频可以播放', {
            readyState: this.audio.readyState,
            networkState: this.audio.networkState
        }));
        this.audio.addEventListener("waiting", () => this.debugLog('音频等待数据', {
            currentTime: this.audio.currentTime,
            readyState: this.audio.readyState
        }));
        this.audio.addEventListener("stalled", () => this.debugLog('音频网络加载停滞'));
        this.audio.addEventListener("seeked", () => {
            this.renderPlaybackProgress(this.getPlaybackPositionMs(), this.getPlaybackDurationMs());
            this.renderLyricsAt(this.getPlaybackPositionMs());
            this.publishState();
        });
        // 3. 播放时间更新事件
        this.audio.addEventListener("timeupdate", () => {
            this.renderPlaybackProgress(this.getPlaybackPositionMs(), this.getPlaybackDurationMs());
            this.renderLyricsAt(this.getPlaybackPositionMs());
            // 超过歌曲限长则自动播放下一首
            if (orderConfiger.overLimitSkip > 0 &&
                this.audio.currentTime > orderConfiger.overLimitSkip &&
                !this.overLimitTriggered) {
                this.overLimitTriggered = true;
                this.playNext();
            }
        });
        // 4. 播放结束事件
        this.audio.addEventListener("ended", () => {
            this.stopProgressAnimation();
            this.renderPlaybackProgress(0, 0, { interactive: false });
            this.resetLyrics();
            this.publishState();
            // 播放下一首歌曲
            this.playNext();
        });
        // 5. 播放失败事件
        this.audio.addEventListener("error", () => {
            const mediaError = this.audio.error;
            this.debugLog('音频 error 事件', {
                code: mediaError?.code,
                message: mediaError?.message || '',
                src: this.describeAudioUrl(this.audio.currentSrc || this.audio.src),
                networkState: this.audio.networkState,
                readyState: this.audio.readyState
            });
            this.updatePlayerState("播放错误");
            this.stopProgressAnimation();
            this.resetLyrics();
            this.renderPlaybackProgress(0, 0, { interactive: false });
            publicMethod.pageAlert("播放错误，即将播放下一首...");
            clearTimeout(this.errorNextTimer);
            this.errorNextTimer = setTimeout(() => {
                // 播放下一首歌曲
                this.playNext();
            }, 6000);
        });
    }

    // 播放歌曲
    async play(song, requester = '') {
        const requestId = ++this.playbackRequestId;
        clearTimeout(this.errorNextTimer);
        this.errorNextTimer = null;
        this.overLimitTriggered = false;

        this.stopProgressAnimation();
        this.lyricAbortController?.abort();
        this.resetLyrics({ loading: true });
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
        this.loadedAudioSongId = '';
        this.renderPlaybackProgress(0, 0, { interactive: false });

        this.currentSong = song;
        this.currentRequester = requester;
        this.updateNowPlaying(song, requester);
        this.publishState();
        this.debugLog('开始播放歌曲', {
            platform: song?.platform,
            songId: song?.sid,
            songName: song?.sname,
            artist: song?.sartist,
            requester
        });

        // 根据平台查询歌曲链接
        let songurl = null;
        try {
            songurl = await musicServer.getServer(song.platform).getSongUrl(song.sid);
        } catch (error) {
            this.debugLog('获取歌曲播放地址异常', {
                platform: song?.platform,
                songId: song?.sid,
                message: error.message
            });
        }
        this.debugLog('歌曲播放地址结果', {
            platform: song?.platform,
            songId: song?.sid,
            hasUrl: Boolean(songurl),
            url: this.describeAudioUrl(songurl)
        });

        if (!songurl) {
            if (requestId !== this.playbackRequestId) return;
            this.resetLyrics();
            this.renderPlaybackProgress(0, 0, { interactive: false });
            publicMethod.pageAlert("获取歌曲链接失败，即将播放下一首...");
            this.autoSkipCount += 1;
            const autoSkipLimit = Math.max(1, this.orderList.length + this.idleSongList.length);
            if (this.autoSkipCount > autoSkipLimit) {
                this.isSwitching = false;
                this.pendingNext = false;
                this.updatePlayerState('歌曲链接获取失败，请检查歌单或网络');
                publicMethod.pageAlert('连续歌曲链接获取失败，已停止自动切歌');
                return;
            }
            clearTimeout(this.errorNextTimer);
            this.errorNextTimer = setTimeout(() => {
                if (requestId !== this.playbackRequestId) return;
                this.isSwitching = false;
                this.pendingNext = false;
                this.playNext();
            }, 1500);
            this.isSwitching = false;
            return;
        }

        // 旧歌曲的异步请求不能再写入 audio，避免切歌时歌名/音频错位。
        if (requestId !== this.playbackRequestId || this.isMirrorMode) {
            // 当前请求因切歌或租约变化而失效时，不能把播放器锁死在切歌状态。
            if (requestId === this.playbackRequestId) {
                this.isSwitching = false;
                if (this.isMirrorMode) this.pendingNext = false;
                else this._flushPending();
            }
            return;
        }

        this.audio.src = songurl;
        this.autoSkipCount = 0;
        this.loadedAudioSongId = this.songKey(song);
        this.loadLyricsForSong(song);
        this.renderPlaybackProgress(0, Math.max(0, Number(song.duration || 0) * 1000));
        this.debugLog('已设置 audio.src', {
            src: this.describeAudioUrl(songurl),
            muted: this.audio.muted,
            volume: this.audio.volume
        });

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

        // 播放；如果浏览器拦截有声自动播放，先静音启动，再恢复声音。
        const played = await this.playAudioWithFallback('new-song');
        if (requestId !== this.playbackRequestId || this.isMirrorMode) {
            if (requestId === this.playbackRequestId) {
                this.isSwitching = false;
                if (this.isMirrorMode) this.pendingNext = false;
                else this._flushPending();
            }
            return;
        }
        if (!played) this.updatePlayerState("请点击启用声音");

        // 歌曲开始播放后，清除切歌锁，检查待执行
        this.isSwitching = false;
        this._flushPending();
    }

    // 用户手动点击后解锁浏览器音频策略，并尝试恢复当前歌曲
    async unlockPlayback() {
        if (this.isMirrorMode) {
            this.sendCommand('unlockAudio');
            publicMethod.pageAlert("已发送 OBS 播放页声音指令");
            return;
        }
        if (!this.audio.src) {
            publicMethod.pageAlert(this.idleSongList.length || this.orderList.length
                ? "当前歌曲尚未开始，点击播放开始下一首"
                : "当前没有歌曲，请先加载歌单或点歌");
            return;
        }
        try {
            // 音频已经以静音状态运行时，远程控制只需要解除静音，
            // 不要再次调用 play()，否则会重新触发自动播放拦截。
            if (!this.audio.paused && this.audio.muted) {
                this.audio.muted = false;
                this.audioUnlockRequired = false;
                this.debugLog('已解除音频静音', { reason: 'unlock', remoteSafe: true });
                this.updatePlayerState('播放中');
                publicMethod.pageAlert("声音已启用");
                return;
            }
            const played = await this.playAudioWithFallback('unlock');
            if (!played) throw new Error('浏览器拒绝播放');
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
            this.sendCommand('play');
            return;
        }
        if (this.audio.paused) {
            await this.unlockPlayback();
        } else {
            this.audio.pause();
        }
    }

    async playAudioWithFallback(reason = 'unknown') {
        this.debugLog('尝试播放音频', {
            reason,
            src: this.describeAudioUrl(this.audio.currentSrc || this.audio.src),
            paused: this.audio.paused,
            muted: this.audio.muted,
            volume: this.audio.volume,
            readyState: this.audio.readyState,
            networkState: this.audio.networkState
        });

        // 先以静音状态启动。浏览器通常允许静音自动播放；启动成功后
        // 再解除静音，控制页的远程指令也不需要把用户手势跨页面传递。
        const previousMuted = this.audio.muted;
        this.audio.muted = true;
        try {
            await this.audio.play();
            this.audio.muted = false;
            this.audioUnlockRequired = false;
            this.updateAudioUnlockPrompt();
            this.publishState();
            this.debugLog('静音启动成功并已恢复声音', { reason, mutedBootstrap: true });
            return true;
        } catch (error) {
            this.audio.muted = previousMuted;
            this.debugLog('静音启动失败，尝试直接有声播放', {
                reason,
                name: error.name,
                message: error.message
            });
        }

        try {
            await this.audio.play();
            this.audio.muted = false;
            this.audioUnlockRequired = false;
            this.updateAudioUnlockPrompt();
            this.publishState();
            this.debugLog('有声播放成功', { reason, mutedBootstrap: false });
            return true;
        } catch (error) {
            this.audio.muted = previousMuted;
            this.audioUnlockRequired = true;
            this.updateAudioUnlockPrompt();
            this.publishState();
            this.debugLog('有声播放也失败', {
                reason,
                name: error.name,
                message: error.message
            });
            return false;
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
        this.updateAudioUnlockPrompt();
        this.publishState();
    }

    updateAudioUnlockPrompt() {
        const prompt = document.getElementById('audioUnlockPrompt');
        if (!prompt) return;
        prompt.hidden = this.isMirrorMode || !this.audioUnlockRequired;
    }

    updateQueueView() {
        const count = document.getElementById('queueCount');
        const empty = document.getElementById('emptyQueue');
        const displayCount = this.getQueueDisplayList().length;
        if (count) count.textContent = `${displayCount} 首`;
        if (empty) empty.style.display = displayCount ? 'none' : 'block';
    }

    // 播放下一首
    async playNext() {
        return this.sendCommand('next');
    }

    async requestNext(user = null) {
        const current = this.orderList[0];
        if (!current) {
            publicMethod.pageAlert('当前没有可切换的歌曲');
            return { ok: false, reason: 'empty-queue' };
        }
        if (user && Number(current.uid) !== 0 && Number(current.uid) !== Number(user.uid) && Number(user.uid) !== Number(window.__adminId || 0)) {
            publicMethod.pageAlert('不能切别人点的歌哦(^o^)');
            return { ok: false, reason: 'not-owner' };
        }
        return this.playNext();
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
    async addOrder(order) {
        // 检查点歌信息
        if (!this.checkOrder(order)) {
            return false;
        }
        const result = await this.sendCommand('addOrder', order);
        if (!result?.ok) {
            publicMethod.pageAlert(result?.result?.result?.reason || '点歌被后端拒绝');
            return false;
        }

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
        return true;
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
