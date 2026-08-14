import musicPlayer from './components/music-player.js?v=20260812-25';
import './components/queue-manager.js?v=20260812-2';
import orderConfiger from './components/order-configer.js?v=20260810-41';
import loginConfiger from './components/login-configer.js?v=20260810-42'
import danmuConfiger from './components/danmu-configer.js?v=20260813-1';
import publicMethod from './utils/common.js?v=20260810-41';

const FRONTEND_BUILD_ID = '20260812-25';
window.__DAMUKU_FRONTEND_BUILD_ID = FRONTEND_BUILD_ID;

async function initializeMainPage() {

    const normalizedQuery = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
    const pageParams = new URLSearchParams(normalizedQuery);
    const settingsOnly = pageParams.get('settings') === '1';
    const pageRole = (pageParams.get('source') || '').toLowerCase();
    const lyricOnlyMode = ['1', 'true', 'yes', 'on'].includes((pageParams.get('lyric') || '').toLowerCase());
    const requestedLiveMode = !['0', 'false', 'no', 'off'].includes((pageParams.get('livemode') || 'true').toLowerCase());
    // source=obs 页面即使因为已有播放端而降级为监控，也保持 OBS 的纯列表布局。
    const obsDisplayMode = !settingsOnly && !lyricOnlyMode && !['monitor', 'control', 'preview'].includes(pageRole) && requestedLiveMode;
    let liveMode = obsDisplayMode;
    let serverDisplaySettings = null;
    let settingsRevision = 0;
    let settingsGlobalRevision = 0;
    let settingsRoomRevision = 0;
    let settingsSaveQueue = Promise.resolve();
    const syncBaseForSettings = publicMethod.resolveApiBase(window.API_CONFIG?.bili_api);
    const roomIdForSettings = pageParams.get('roomid') || pageParams.get('room_id') || 'default';

    const syncLyricViewport = () => {
        if (!lyricOnlyMode) return;
        const width = Math.max(1, Math.round(window.innerWidth || document.documentElement.clientWidth || 1));
        const height = Math.max(1, Math.round(window.innerHeight || document.documentElement.clientHeight || 1));
        document.documentElement.style.setProperty('--lyric-viewport-width', `${width}px`);
        document.documentElement.style.setProperty('--lyric-viewport-height', `${height}px`);
        document.documentElement.dataset.lyricViewport = `${width}x${height}`;
    };
    if (lyricOnlyMode) {
        syncLyricViewport();
        window.addEventListener('resize', syncLyricViewport, { passive: true });
        window.visualViewport?.addEventListener('resize', syncLyricViewport, { passive: true });
    }

    // 页面可能来自浏览器缓存，而 Node 服务已经被关闭。先独立探测后端，
    // 不让后续按钮表现成“点击无反应”。遮罩只保留重新检查按钮。
    const backendGuard = createBackendGuard(pageParams);
    backendGuard.start();

    const readFlag = (key, defaultValue) => {
        const value = localStorage.getItem(key);
        return value === null ? defaultValue : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    };

    const legacyArray = key => {
        try {
            const value = JSON.parse(localStorage.getItem(key) || '[]');
            return Array.isArray(value) ? value : [];
        } catch (_) {
            return [];
        }
    };

    const readLegacySettings = () => ({
        order: {
            userMaxOrder: Number(localStorage.getItem('userMaxOrder') || 3),
            globalMaxOrder: Number(localStorage.getItem('globalMaxOrder') || 15),
            orderMaxDuration: Number(localStorage.getItem('orderMaxDuration') || 0),
            overLimitSkip: Number(localStorage.getItem('overLimitSkip') || 0),
            userHistory: legacyArray('userHistory'),
            songHistory: legacyArray('songHistory'),
            userBlackList: legacyArray('userBlackList'),
            songBlackList: legacyArray('songBlackList')
        },
        display: {
            overlayOpacity: Number(localStorage.getItem('overlayOpacity') || 88),
            overlayBlur: Number(localStorage.getItem('overlayBlur') || 14),
            overlayTheme: localStorage.getItem('overlayTheme') || 'dark',
            liveShowPlayer: readFlag('liveShowPlayer', false),
            liveShowControls: readFlag('liveShowControls', false),
            liveShowQueueHeader: readFlag('liveShowQueueHeader', true),
            liveShowRequester: readFlag('liveShowRequester', true),
            liveShowAlerts: readFlag('liveShowAlerts', false),
            lyricsEnabled: readFlag('lyricsEnabled', true),
            lyricsTranslation: readFlag('lyricsTranslation', true),
            lyricsDisplayMode: localStorage.getItem('lyricsDisplayMode') === 'scroll' ? 'scroll' : 'wrap',
            lyricsOffsetMs: Number(localStorage.getItem('lyricsOffsetMs') || 0),
            lyricsFontSize: Number(localStorage.getItem('lyricsFontSize') || 22),
            lyricsColor: localStorage.getItem('lyricsColor') || '#ffffff',
            lyricsOpacity: Number(localStorage.getItem('lyricsOpacity') || 100),
            lyricsOverlayLines: Number(localStorage.getItem('lyricsOverlayLines') || 1),
            lyricsOverlayWidth: Number(localStorage.getItem('lyricsOverlayWidth') || 92),
            progressSeekEnabled: readFlag('progressSeekEnabled', true),
            customOverlayCss: localStorage.getItem('customOverlayCss') || ''
        },
        login: {
            platform: musicServer.platform,
            songListId: localStorage.getItem('songListId') || '',
            songListHistory: legacyArray('songListHistory')
        }
    });

    const applyAuthoritativeSettings = data => {
        if (!data) return;
        settingsRevision = Number(data.revision || Math.max(data.globalRevision || 0, data.roomRevision || 0));
        settingsGlobalRevision = Number(data.globalRevision || 0);
        settingsRoomRevision = Number(data.roomRevision || 0);
        serverDisplaySettings = data.display || null;
        window.__displaySettings = serverDisplaySettings || {};
        if (data.order) orderConfiger.applySharedState(data.order);
        if (data.login) loginConfiger.applySharedState(data.login);
        if (data.volume != null) musicPlayer.applyVolume(data.volume);
        applyAppearance();
        window.dispatchEvent(new CustomEvent('bilibili-display-settings-changed'));
    };

    const fetchAuthoritativeSettings = async ({ migrate = false } = {}) => {
        if (!syncBaseForSettings) return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        try {
            const response = await fetch(`${syncBaseForSettings}/live/settings?room_id=${encodeURIComponent(roomIdForSettings)}`, {
                cache: 'no-store',
                signal: controller.signal
            });
            const result = await response.json();
            if (!response.ok || result.code !== 0) return null;
            let data = result.data;
            if (migrate && !data.hasStored) {
                const legacy = readLegacySettings();
                const hasLegacy = Object.keys(localStorage).some(key => [
                    'userMaxOrder', 'globalMaxOrder', 'orderMaxDuration', 'overLimitSkip',
                    'userHistory', 'songHistory', 'userBlackList', 'songBlackList',
                    'overlayOpacity', 'overlayBlur', 'overlayTheme', 'customOverlayCss',
                    'lyricsOverlayWidth', 'lyricsDisplayMode',
                    'songListId', 'songListHistory'
                ].includes(key));
                if (hasLegacy) {
                    const migrated = await saveAuthoritativeSettings(legacy, { allowMigration: true });
                    if (migrated) data = migrated;
                }
            }
            applyAuthoritativeSettings(data);
            return data;
        } catch (_) {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    };

    const saveAuthoritativeSettings = async (settings, { allowMigration = false } = {}) => {
        const save = async () => {
            if (!syncBaseForSettings) return null;
            try {
                const response = await fetch(`${syncBaseForSettings}/live/settings`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    room_id: roomIdForSettings,
                    revision: allowMigration ? undefined : settingsRevision,
                    globalRevision: allowMigration ? undefined : settingsGlobalRevision,
                    roomRevision: allowMigration ? undefined : settingsRoomRevision,
                    settings
                }),
                cache: 'no-store'
                });
                const result = await response.json().catch(() => null);
                if (!response.ok || result?.code !== 0) {
                    if (!allowMigration) await fetchAuthoritativeSettings();
                    return null;
                }
                applyAuthoritativeSettings(result.data);
                return result.data;
            } catch (_) {
                return null;
            }
        };
        const task = settingsSaveQueue.then(save, save);
        settingsSaveQueue = task.catch(() => null);
        return task;
    };

    const applyCustomCss = () => {
        const customCss = serverDisplaySettings?.customOverlayCss ?? '';
        const style = document.getElementById('customOverlayStyle');
        const editor = document.getElementById('customOverlayCss');
        if (style) style.textContent = customCss;
        if (editor && editor.value !== customCss) editor.value = customCss;
    };

    const applyAppearance = () => {
        const display = serverDisplaySettings || {};
        const value = (key, fallback) => display[key] == null ? fallback : display[key];
        const opacity = Number(value('overlayOpacity', 88));
        const blur = Number(value('overlayBlur', 14));
        const theme = value('overlayTheme', 'dark');
        const liveShowPlayer = Boolean(value('liveShowPlayer', false));
        const liveShowControls = Boolean(value('liveShowControls', false));
        const liveShowQueueHeader = Boolean(value('liveShowQueueHeader', true));
        const liveShowRequester = Boolean(value('liveShowRequester', true));
        const liveShowAlerts = Boolean(value('liveShowAlerts', false));
        document.documentElement.style.setProperty('--overlay-opacity', String(opacity / 100));
        document.documentElement.style.setProperty('--overlay-blur', `${blur}px`);
        document.documentElement.style.setProperty('--lyrics-font-size', `${Math.max(12, Math.min(64, Number(value('lyricsFontSize', 22))))}px`);
        document.documentElement.style.setProperty('--lyrics-color', String(value('lyricsColor', '#ffffff')));
        document.documentElement.style.setProperty('--lyrics-opacity', String(Math.max(.1, Math.min(1, Number(value('lyricsOpacity', 100)) / 100))));
        document.documentElement.style.setProperty('--lyrics-overlay-width', `${Math.max(50, Math.min(100, Number(value('lyricsOverlayWidth', 92))))}%`);
        document.body.classList.toggle('liveMode', liveMode);
        document.body.classList.toggle('lyricOverlay', lyricOnlyMode);
        document.body.classList.toggle('liveShowPlayer', liveMode && liveShowPlayer);
        document.body.classList.toggle('liveShowControls', liveMode && liveShowControls);
        document.body.classList.toggle('liveShowQueueHeader', liveMode && liveShowQueueHeader);
        document.body.classList.toggle('liveShowRequester', liveMode && liveShowRequester);
        document.body.classList.toggle('liveShowAlerts', liveMode && liveShowAlerts);
        document.body.classList.toggle('overlayLight', theme === 'light');
        const opacityInput = document.getElementById('overlayOpacity');
        const blurInput = document.getElementById('overlayBlur');
        const themeInput = document.getElementById('overlayTheme');
        const liveInputs = {
            liveShowPlayer: document.getElementById('liveShowPlayer'),
            liveShowControls: document.getElementById('liveShowControls'),
            liveShowQueueHeader: document.getElementById('liveShowQueueHeader'),
            liveShowRequester: document.getElementById('liveShowRequester'),
            liveShowAlerts: document.getElementById('liveShowAlerts')
        };
        const opacityValue = document.getElementById('overlayOpacityValue');
        const blurValue = document.getElementById('overlayBlurValue');
        if (opacityInput) opacityInput.value = String(opacity);
        if (blurInput) blurInput.value = String(blur);
        if (themeInput) themeInput.value = theme;
        Object.entries(liveInputs).forEach(([key, input]) => {
            if (input) input.checked = Boolean(value(key, key === 'liveShowQueueHeader' || key === 'liveShowRequester'));
        });
        for (const key of ['lyricsEnabled', 'lyricsTranslation', 'progressSeekEnabled']) {
            const input = document.getElementById(key);
            if (input) input.checked = Boolean(value(key, true));
        }
        const lyricsDisplayModeInput = document.getElementById('lyricsDisplayMode');
        if (lyricsDisplayModeInput) lyricsDisplayModeInput.value = value('lyricsDisplayMode', 'wrap');
        for (const key of ['lyricsOffsetMs', 'lyricsFontSize']) {
            const input = document.getElementById(key);
            if (input) input.value = String(value(key, key === 'lyricsFontSize' ? 22 : 0));
        }
        if (opacityValue) opacityValue.textContent = `${opacity}%`;
        if (blurValue) blurValue.textContent = `${blur}px`;
        const lyricsColorInput = document.getElementById('lyricsColor');
        const lyricsOpacityInput = document.getElementById('lyricsOpacity');
        const lyricsOpacityValue = document.getElementById('lyricsOpacityValue');
        const lyricsOverlayLinesInput = document.getElementById('lyricsOverlayLines');
        const lyricsOverlayWidthInput = document.getElementById('lyricsOverlayWidth');
        const lyricsOverlayWidthValue = document.getElementById('lyricsOverlayWidthValue');
        if (lyricsColorInput) lyricsColorInput.value = String(value('lyricsColor', '#ffffff'));
        if (lyricsOpacityInput) lyricsOpacityInput.value = String(value('lyricsOpacity', 100));
        if (lyricsOpacityValue) lyricsOpacityValue.textContent = `${value('lyricsOpacity', 100)}%`;
        if (lyricsOverlayLinesInput) lyricsOverlayLinesInput.value = String(value('lyricsOverlayLines', 1));
        if (lyricsOverlayWidthInput) lyricsOverlayWidthInput.value = String(value('lyricsOverlayWidth', 92));
        if (lyricsOverlayWidthValue) lyricsOverlayWidthValue.textContent = `${value('lyricsOverlayWidth', 92)}%`;
        applyCustomCss();
    };
    const getDisplaySettings = () => ({
        overlayOpacity: Number(document.getElementById('overlayOpacity')?.value || 88),
        overlayBlur: Number(document.getElementById('overlayBlur')?.value || 14),
        overlayTheme: document.getElementById('overlayTheme')?.value || 'dark',
        liveShowPlayer: Boolean(document.getElementById('liveShowPlayer')?.checked),
        liveShowControls: Boolean(document.getElementById('liveShowControls')?.checked),
        liveShowQueueHeader: Boolean(document.getElementById('liveShowQueueHeader')?.checked),
        liveShowRequester: Boolean(document.getElementById('liveShowRequester')?.checked),
        liveShowAlerts: Boolean(document.getElementById('liveShowAlerts')?.checked),
        lyricsEnabled: Boolean(document.getElementById('lyricsEnabled')?.checked),
        lyricsTranslation: Boolean(document.getElementById('lyricsTranslation')?.checked),
        lyricsDisplayMode: document.getElementById('lyricsDisplayMode')?.value === 'scroll' ? 'scroll' : 'wrap',
        lyricsOffsetMs: Number(document.getElementById('lyricsOffsetMs')?.value || 0),
        lyricsFontSize: Number(document.getElementById('lyricsFontSize')?.value || 22),
        lyricsColor: document.getElementById('lyricsColor')?.value || '#ffffff',
        lyricsOpacity: Number(document.getElementById('lyricsOpacity')?.value || 100),
        lyricsOverlayLines: Number(document.getElementById('lyricsOverlayLines')?.value || 1),
        lyricsOverlayWidth: Number(document.getElementById('lyricsOverlayWidth')?.value || 92),
        progressSeekEnabled: Boolean(document.getElementById('progressSeekEnabled')?.checked),
        customOverlayCss: document.getElementById('customOverlayCss')?.value || ''
    });
    const publishDisplaySettings = () => {
        saveAuthoritativeSettings({ display: getDisplaySettings() });
    };
    await fetchAuthoritativeSettings({ migrate: true });
    applyAppearance();

    const opacityInput = document.getElementById('overlayOpacity');
    const blurInput = document.getElementById('overlayBlur');
    const themeInput = document.getElementById('overlayTheme');
    const customCssEditor = document.getElementById('customOverlayCss');
    if (opacityInput) opacityInput.oninput = () => {
        publishDisplaySettings();
    };
    if (blurInput) blurInput.oninput = () => {
        publishDisplaySettings();
    };
    if (themeInput) themeInput.onchange = () => {
        publishDisplaySettings();
    };
    ['liveShowPlayer', 'liveShowControls', 'liveShowQueueHeader', 'liveShowRequester', 'liveShowAlerts'].forEach(key => {
        const input = document.getElementById(key);
        if (input) input.onchange = () => {
            publishDisplaySettings();
        };
    });
    ['lyricsEnabled', 'lyricsTranslation', 'lyricsDisplayMode', 'lyricsOffsetMs', 'lyricsFontSize', 'lyricsColor', 'lyricsOpacity', 'lyricsOverlayLines', 'lyricsOverlayWidth', 'progressSeekEnabled'].forEach(key => {
        const input = document.getElementById(key);
        if (input) input.onchange = () => {
            publishDisplaySettings();
            window.dispatchEvent(new CustomEvent('bilibili-display-settings-changed'));
        };
    });
    if (customCssEditor) customCssEditor.value = '';
    const applyCustomCssButton = document.getElementById('applyCustomCss');
    const clearCustomCssButton = document.getElementById('clearCustomCss');
    if (applyCustomCssButton) applyCustomCssButton.onclick = () => {
        applyCustomCss();
        publishDisplaySettings();
        publicMethod.pageAlert('自定义 CSS 已应用');
    };
    if (clearCustomCssButton) clearCustomCssButton.onclick = () => {
        publishDisplaySettings();
        applyCustomCss();
    };

    //  显示设置界面 
    let elem_orderTable = document.getElementsByClassName("orderTable")[0];
    let elem_setting = document.getElementsByClassName("setting")[0];
    if (settingsOnly) {
        document.body.classList.add('settingsOnly');
        elem_setting.style.height = "100vh";
    } else {
        elem_setting.style.height = "0px";
        elem_orderTable.onclick = null;
    }
    window.setInterval(() => fetchAuthoritativeSettings(), 5000);

    // 隐藏设置界面
    document.getElementById('upBtn').onclick = () => {
        elem_setting.style.height = "0px";
    }

    // 设置界面切换
    let elem_menu = document.getElementById('menu');
    let elem_pages = document.getElementById('pages');
    let elem_settingBody = document.getElementsByClassName('setting_body')[0];
    for (let i = 0; i < elem_menu.children.length - 1; i++) {
        const btn = elem_menu.children[i];
        btn.onclick = () => {
            // 使用百分比分页，避免滚动条出现/消失导致实际宽度变化而错位。
            elem_settingBody.scrollLeft = 0;
            elem_pages.style.left = -(100 * i) + "%";
            elem_settingBody.scrollLeft = 0;
        }
    }

    // 等待播放端租约确认后再启动弹幕和自动歌单。第二个打开的播放链接
    // 会在这里已经降级成监控端，不会再各自加载一份空闲歌单。
    await musicPlayer.ready;
    const playbackMode = !settingsOnly && !musicPlayer.isMirrorMode;
    const realtimeDebugObserver = !settingsOnly && musicPlayer.isMirrorMode &&
        ['1', 'true', 'yes', 'on'].includes((pageParams.get('realtime') || '').toLowerCase()) &&
        ['1', 'true', 'yes', 'on'].includes((pageParams.get('debug') || '').toLowerCase());
    liveMode = obsDisplayMode;
    applyAppearance();
    let playbackStarted = false;
    const startPlaybackServices = () => {
        if (settingsOnly || musicPlayer.isMirrorMode || playbackStarted) return;
        playbackStarted = true;
        danmuConfiger.startDanmu();
        if (!musicPlayer.idleSongList.length && !musicPlayer.audio.src) {
            loginConfiger.loadSongList();
        }
    };
    window.addEventListener('bilibili-ordersong-publisher-claimed', startPlaybackServices);
    if (playbackMode) startPlaybackServices();
    // 控制/镜像页通常不连接弹幕。仅在 realtime=1&debug=1 时建立只读诊断连接，
    // 用于确认 WebSocket 实时收包；不注册点歌回调，避免和 OBS 播放页重复点歌。
    if (realtimeDebugObserver) danmuConfiger.startDanmu({ processCommands: false });
    if (!settingsOnly && !playbackMode) musicPlayer.requestSharedState();

    // 播放控制。浏览器通常不允许弹幕事件直接触发声音，用户点击一次即可解锁。
    const unlockAudio = () => musicPlayer.unlockPlayback();
    document.getElementById('unlockAudioBtn').onclick = unlockAudio;
    document.getElementById('audioUnlockPromptBtn').onclick = unlockAudio;
    document.getElementById('togglePlayBtn').onclick = () => musicPlayer.togglePlayback();
    document.getElementById('nextSongBtn').onclick = () => musicPlayer.playNext();
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeValue = document.getElementById('volumeValue');
    if (volumeSlider) {
        volumeSlider.value = String(musicPlayer.volumePercent);
        if (volumeValue) volumeValue.textContent = `${musicPlayer.volumePercent}%`;
        volumeSlider.oninput = () => musicPlayer.setVolume(volumeSlider.value);
    }
    const progressSlider = document.getElementById('progressSlider');
    if (progressSlider) {
        progressSlider.onpointerdown = () => { musicPlayer.progressDragging = true; };
        progressSlider.oninput = () => {
            musicPlayer.progressDragging = true;
            musicPlayer.renderPlaybackProgress(Number(progressSlider.value), musicPlayer.getPlaybackDurationMs());
            musicPlayer.renderLyricsAt(Number(progressSlider.value));
        };
        progressSlider.onchange = () => musicPlayer.commitSeek(Number(progressSlider.value));
        progressSlider.onpointerup = () => {
            if (musicPlayer.progressDragging) musicPlayer.commitSeek(Number(progressSlider.value));
        };
        progressSlider.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') musicPlayer.commitSeek(Number(progressSlider.value));
        };
    }
    document.getElementById('settingsBtn').onclick = () => {
        const settingsUrl = new URL('./settings.html', window.location.href);
        const currentParams = new URLSearchParams(window.location.search.replace(/^\?/, '').replace(/\?/g, '&'));
        for (const key of ['roomid', 'room_id']) {
            const value = currentParams.get(key);
            if (value) settingsUrl.searchParams.set(key, value);
        }
        const settingsWindow = window.open(settingsUrl.href, 'Damuku_music-settings');
        if (!settingsWindow) publicMethod.pageAlert('设置页被浏览器拦截，请允许弹出窗口');
    };

}

function createBackendGuard(pageParams) {
    const overlay = document.getElementById('backendOfflineOverlay');
    const title = document.getElementById('backendOfflineTitle');
    const message = document.getElementById('backendOfflineMessage');
    const retryButton = document.getElementById('backendRetryBtn');
    const versionOverlay = document.getElementById('versionMismatchOverlay');
    const versionMessage = document.getElementById('versionMismatchMessage');
    const frontendBuildIdText = document.getElementById('frontendBuildIdText');
    const backendBuildIdText = document.getElementById('backendBuildIdText');
    const clearCacheRefreshButton = document.getElementById('clearCacheRefreshBtn');
    const versionRefreshButton = document.getElementById('versionRefreshBtn');
    const interactiveElements = [...document.querySelectorAll('button, input, select, textarea')]
        .filter(element => element !== retryButton &&
            !element.closest('#backendOfflineOverlay') && !element.closest('#versionMismatchOverlay'));
    const configuredSyncBase = publicMethod.resolveApiBase(window.API_CONFIG?.bili_api);
    const syncBase = configuredSyncBase ||
        new URL('./bili-api', window.location.href).pathname.replace(/\/$/, '');
    const roomId = pageParams.get('roomid') || pageParams.get('room_id') || 'default';
    let available = false;
    let checking = false;
    let versionMismatch = false;

    const reloadPage = () => {
        const url = new URL(window.location.href);
        url.searchParams.set('_damuku_refresh', String(Date.now()));
        window.location.replace(url.href);
    };

    const clearCacheAndRefresh = async () => {
        if (clearCacheRefreshButton) {
            clearCacheRefreshButton.disabled = true;
            clearCacheRefreshButton.textContent = '正在清空缓存...';
        }
        try {
            if ('caches' in window) {
                const cacheNames = await caches.keys();
                await Promise.all(cacheNames.map(cacheName => caches.delete(cacheName)));
            }
            // 只清理本次版本检测的临时标记，不删除登录态和业务设置。
            sessionStorage.removeItem('damukuBuildId');
            sessionStorage.removeItem('damukuReloadedForBuild');
        } finally {
            reloadPage();
        }
    };

    const setVersionMismatch = (frontendBuildId, backendBuildId) => {
        versionMismatch = true;
        if (frontendBuildIdText) frontendBuildIdText.textContent = frontendBuildId || '未知';
        if (backendBuildIdText) backendBuildIdText.textContent = backendBuildId || '未知';
        if (versionMessage) versionMessage.textContent =
            `当前页面加载的 JavaScript 与后端版本不一致（页面 ${frontendBuildId || '未知'}，后端 ${backendBuildId || '未知'}），请刷新页面。`;
        if (versionOverlay) versionOverlay.hidden = false;
        setAvailability(true);
    };

    const setAvailability = (nextAvailable) => {
        available = nextAvailable;
        window.__backendAvailable = available;
        document.body.classList.toggle('backendOffline', !available);
        if (overlay) overlay.hidden = available;
        interactiveElements.forEach(element => {
            if (!element.dataset.backendGuardOriginalDisabled) {
                element.dataset.backendGuardOriginalDisabled = element.disabled ? '1' : '0';
            }
            element.disabled = !available || versionMismatch || element.dataset.backendGuardOriginalDisabled === '1';
        });
    };

    const check = async () => {
        if (checking) return available;
        checking = true;
        // 在线状态下不要先切成离线再等待请求，否则每 5 秒都会闪一下遮罩，
        // 还会短暂禁用播放器按钮。只有首次检查或上次已离线时显示检查状态。
        if (!available) {
            if (title) title.textContent = '正在检查后端服务';
            if (message) message.textContent = '请稍候，正在确认点歌台服务是否运行。';
            setAvailability(false);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        try {
            const response = await fetch(`${syncBase}/live/health?room_id=${encodeURIComponent(roomId)}`, {
                cache: 'no-store',
                signal: controller.signal
            });
            const result = await response.json();
            if (!response.ok || result.code !== 0) throw new Error('后端健康检查失败');
            const backendBuildId = String(result.data?.buildId || '');
            const frontendBuildId = String(window.__DAMUKU_FRONTEND_BUILD_ID || '');
            if (backendBuildId && frontendBuildId && backendBuildId !== frontendBuildId) {
                setVersionMismatch(frontendBuildId, backendBuildId);
                return true;
            }
            versionMismatch = false;
            if (versionOverlay) versionOverlay.hidden = true;
            if (backendBuildId) sessionStorage.setItem('damukuBuildId', backendBuildId);
            setAvailability(true);
            return true;
        } catch (_) {
            if (title) title.textContent = '后端服务未运行';
            if (message) message.textContent = '点歌台后端没有启动，当前页面操作已禁用。请先启动 Node 服务后点击重新检查。';
            setAvailability(false);
            return false;
        } finally {
            clearTimeout(timeout);
            checking = false;
        }
    };

    retryButton?.addEventListener('click', check);
    versionRefreshButton?.addEventListener('click', reloadPage);
    clearCacheRefreshButton?.addEventListener('click', clearCacheAndRefresh);
    return {
        start() {
            check();
            window.setInterval(check, 5000);
        },
        check
    };
}

// 模块脚本可能在页面 load 事件之后才执行，不能只依赖 window.onload。
const runMainInitialization = () => {
    Promise.resolve(initializeMainPage()).catch(error => {
        console.error('页面初始化失败', error);
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runMainInitialization, { once: true });
} else {
    runMainInitialization();
}
window.musicPlayer = musicPlayer;
window.orderConfiger = orderConfiger;
window.loginConfiger = loginConfiger;
window.danmuConfiger = danmuConfiger;
