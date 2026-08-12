import musicPlayer from './components/music-player.js?v=20260812-4';
import orderConfiger from './components/order-configer.js?v=20260810-41';
import loginConfiger from './components/login-configer.js?v=20260810-42'
import danmuConfiger from './components/danmu-configer.js?v=20260810-41';
import publicMethod from './utils/common.js?v=20260810-41';

async function initializeMainPage() {

    const normalizedQuery = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
    const pageParams = new URLSearchParams(normalizedQuery);
    const settingsOnly = pageParams.get('settings') === '1';
    const pageRole = (pageParams.get('source') || '').toLowerCase();
    const requestedLiveMode = !['0', 'false', 'no', 'off'].includes((pageParams.get('livemode') || 'true').toLowerCase());
    // source=obs 页面即使因为已有播放端而降级为监控，也保持 OBS 的纯列表布局。
    const obsDisplayMode = !settingsOnly && !['monitor', 'control', 'preview'].includes(pageRole) && requestedLiveMode;
    let liveMode = obsDisplayMode;
    let serverDisplaySettings = null;

    // 页面可能来自浏览器缓存，而 Node 服务已经被关闭。先独立探测后端，
    // 不让后续按钮表现成“点击无反应”。遮罩只保留重新检查按钮。
    const backendGuard = createBackendGuard(pageParams);
    backendGuard.start();

    const readFlag = (key, defaultValue) => {
        const value = localStorage.getItem(key);
        return value === null ? defaultValue : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    };

    const applyCustomCss = () => {
        const customCss = serverDisplaySettings?.customOverlayCss ?? localStorage.getItem('customOverlayCss') ?? '';
        const style = document.getElementById('customOverlayStyle');
        const editor = document.getElementById('customOverlayCss');
        if (style) style.textContent = customCss;
        if (editor && editor.value !== customCss) editor.value = customCss;
    };

    const applyAppearance = () => {
        const display = serverDisplaySettings || {};
        const value = (key, fallback) => display[key] == null ? fallback : display[key];
        const opacity = Number(value('overlayOpacity', Number(localStorage.getItem('overlayOpacity') || 88)));
        const blur = Number(value('overlayBlur', Number(localStorage.getItem('overlayBlur') || 14)));
        const theme = value('overlayTheme', localStorage.getItem('overlayTheme') || 'dark');
        const liveShowPlayer = Boolean(value('liveShowPlayer', readFlag('liveShowPlayer', false)));
        const liveShowControls = Boolean(value('liveShowControls', readFlag('liveShowControls', false)));
        const liveShowQueueHeader = Boolean(value('liveShowQueueHeader', readFlag('liveShowQueueHeader', true)));
        const liveShowRequester = Boolean(value('liveShowRequester', readFlag('liveShowRequester', true)));
        const liveShowAlerts = Boolean(value('liveShowAlerts', readFlag('liveShowAlerts', false)));
        document.documentElement.style.setProperty('--overlay-opacity', String(opacity / 100));
        document.documentElement.style.setProperty('--overlay-blur', `${blur}px`);
        document.body.classList.toggle('liveMode', liveMode);
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
        if (opacityValue) opacityValue.textContent = `${opacity}%`;
        if (blurValue) blurValue.textContent = `${blur}px`;
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
        customOverlayCss: document.getElementById('customOverlayCss')?.value || ''
    });
    const publishDisplaySettings = () => {
        serverDisplaySettings = getDisplaySettings();
        musicPlayer.sendCommand('settings', { display: serverDisplaySettings });
        applyAppearance();
    };
    applyAppearance();

    const opacityInput = document.getElementById('overlayOpacity');
    const blurInput = document.getElementById('overlayBlur');
    const themeInput = document.getElementById('overlayTheme');
    const customCssEditor = document.getElementById('customOverlayCss');
    if (opacityInput) opacityInput.oninput = () => {
        localStorage.setItem('overlayOpacity', opacityInput.value);
        publishDisplaySettings();
    };
    if (blurInput) blurInput.oninput = () => {
        localStorage.setItem('overlayBlur', blurInput.value);
        publishDisplaySettings();
    };
    if (themeInput) themeInput.onchange = () => {
        localStorage.setItem('overlayTheme', themeInput.value);
        publishDisplaySettings();
    };
    ['liveShowPlayer', 'liveShowControls', 'liveShowQueueHeader', 'liveShowRequester', 'liveShowAlerts'].forEach(key => {
        const input = document.getElementById(key);
        if (input) input.onchange = () => {
            localStorage.setItem(key, String(input.checked));
            publishDisplaySettings();
        };
    });
    if (customCssEditor) customCssEditor.value = localStorage.getItem('customOverlayCss') || '';
    const applyCustomCssButton = document.getElementById('applyCustomCss');
    const clearCustomCssButton = document.getElementById('clearCustomCss');
    if (applyCustomCssButton) applyCustomCssButton.onclick = () => {
        localStorage.setItem('customOverlayCss', customCssEditor?.value || '');
        applyCustomCss();
        publishDisplaySettings();
        publicMethod.pageAlert('自定义 CSS 已应用');
    };
    if (clearCustomCssButton) clearCustomCssButton.onclick = () => {
        localStorage.removeItem('customOverlayCss');
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
    const syncBaseForSettings = publicMethod.resolveApiBase(window.API_CONFIG?.bili_api);
    const syncDisplaySettings = async () => {
        if (!syncBaseForSettings) return;
        try {
            const roomId = pageParams.get('roomid') || pageParams.get('room_id') || 'default';
            const response = await fetch(`${syncBaseForSettings}/live/settings?room_id=${encodeURIComponent(roomId)}`, { cache: 'no-store' });
            const result = await response.json();
            if (response.ok && result.code === 0 && result.data?.display) {
                serverDisplaySettings = result.data.display;
                applyAppearance();
            }
            if (response.ok && result.code === 0 && result.data?.order) {
                window.dispatchEvent(new CustomEvent('bilibili-ordersong-shared-settings', {
                    detail: { order: result.data.order, login: result.data.login || null }
                }));
            }
        } catch (_) { /* backend guard handles unavailable service */ }
    };
    syncDisplaySettings();
    window.setInterval(syncDisplaySettings, 5000);

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
    const interactiveElements = [...document.querySelectorAll('button, input, select, textarea')]
        .filter(element => element !== retryButton && !element.closest('#backendOfflineOverlay'));
    const configuredSyncBase = publicMethod.resolveApiBase(window.API_CONFIG?.bili_api);
    const syncBase = configuredSyncBase ||
        new URL('./bili-api', window.location.href).pathname.replace(/\/$/, '');
    const roomId = pageParams.get('roomid') || pageParams.get('room_id') || 'default';
    let available = false;
    let checking = false;

    const setAvailability = (nextAvailable) => {
        available = nextAvailable;
        window.__backendAvailable = available;
        document.body.classList.toggle('backendOffline', !available);
        if (overlay) overlay.hidden = available;
        interactiveElements.forEach(element => {
            if (!element.dataset.backendGuardOriginalDisabled) {
                element.dataset.backendGuardOriginalDisabled = element.disabled ? '1' : '0';
            }
            element.disabled = !available || element.dataset.backendGuardOriginalDisabled === '1';
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
            const buildId = result.data?.buildId || '';
            const previousBuildId = sessionStorage.getItem('damukuBuildId');
            if (buildId && previousBuildId && previousBuildId !== buildId && !sessionStorage.getItem('damukuReloadedForBuild')) {
                sessionStorage.setItem('damukuReloadedForBuild', '1');
                window.location.reload();
                return true;
            }
            if (buildId) {
                sessionStorage.setItem('damukuBuildId', buildId);
                sessionStorage.removeItem('damukuReloadedForBuild');
            }
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
