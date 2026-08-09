import musicPlayer from './components/music-player.js';
import orderConfiger from './components/order-configer.js';
import loginConfiger from './components/login-configer.js'
import danmuConfiger from './components/danmu-configer.js';
import publicMethod from './utils/common.js';

window.onload = function () {

    const normalizedQuery = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
    const pageParams = new URLSearchParams(normalizedQuery);
    const settingsOnly = pageParams.get('settings') === '1';
    const liveMode = !['0', 'false', 'no', 'off'].includes((pageParams.get('livemode') || 'true').toLowerCase());

    const readFlag = (key, defaultValue) => {
        const value = localStorage.getItem(key);
        return value === null ? defaultValue : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    };

    const applyCustomCss = () => {
        const customCss = localStorage.getItem('customOverlayCss') || '';
        const style = document.getElementById('customOverlayStyle');
        const editor = document.getElementById('customOverlayCss');
        if (style) style.textContent = customCss;
        if (editor && editor.value !== customCss) editor.value = customCss;
    };

    const applyAppearance = () => {
        const opacity = Number(localStorage.getItem('overlayOpacity') || 88);
        const blur = Number(localStorage.getItem('overlayBlur') || 14);
        const theme = localStorage.getItem('overlayTheme') || 'dark';
        const liveShowPlayer = readFlag('liveShowPlayer', false);
        const liveShowControls = readFlag('liveShowControls', false);
        const liveShowQueueHeader = readFlag('liveShowQueueHeader', true);
        const liveShowRequester = readFlag('liveShowRequester', true);
        const liveShowAlerts = readFlag('liveShowAlerts', false);
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
            if (input) input.checked = readFlag(key, key === 'liveShowQueueHeader' || key === 'liveShowRequester');
        });
        if (opacityValue) opacityValue.textContent = `${opacity}%`;
        if (blurValue) blurValue.textContent = `${blur}px`;
        applyCustomCss();
    };
    applyAppearance();

    const opacityInput = document.getElementById('overlayOpacity');
    const blurInput = document.getElementById('overlayBlur');
    const themeInput = document.getElementById('overlayTheme');
    const customCssEditor = document.getElementById('customOverlayCss');
    if (opacityInput) opacityInput.oninput = () => {
        localStorage.setItem('overlayOpacity', opacityInput.value);
        applyAppearance();
    };
    if (blurInput) blurInput.oninput = () => {
        localStorage.setItem('overlayBlur', blurInput.value);
        applyAppearance();
    };
    if (themeInput) themeInput.onchange = () => {
        localStorage.setItem('overlayTheme', themeInput.value);
        applyAppearance();
    };
    ['liveShowPlayer', 'liveShowControls', 'liveShowQueueHeader', 'liveShowRequester', 'liveShowAlerts'].forEach(key => {
        const input = document.getElementById(key);
        if (input) input.onchange = () => {
            localStorage.setItem(key, String(input.checked));
            applyAppearance();
        };
    });
    if (customCssEditor) customCssEditor.value = localStorage.getItem('customOverlayCss') || '';
    const applyCustomCssButton = document.getElementById('applyCustomCss');
    const clearCustomCssButton = document.getElementById('clearCustomCss');
    if (applyCustomCssButton) applyCustomCssButton.onclick = () => {
        localStorage.setItem('customOverlayCss', customCssEditor?.value || '');
        applyCustomCss();
        publicMethod.pageAlert('自定义 CSS 已应用');
    };
    if (clearCustomCssButton) clearCustomCssButton.onclick = () => {
        localStorage.removeItem('customOverlayCss');
        applyCustomCss();
    };

    //  显示设置界面 
    let elem_orderTable = document.getElementsByClassName("orderTable")[0];
    let elem_setting = document.getElementsByClassName("setting")[0];
    if (settingsOnly) {
        document.body.classList.add('settingsOnly');
        elem_setting.style.height = "100vh";
    } else {
        elem_orderTable.onclick = () => {
            elem_setting.style.height = "500px";
        }
    }

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

    // 启动弹幕连接
    if (!settingsOnly && liveMode) danmuConfiger.startDanmu();
    if (!settingsOnly && !liveMode) musicPlayer.requestSharedState();

    // 播放控制。浏览器通常不允许弹幕事件直接触发声音，用户点击一次即可解锁。
    document.getElementById('unlockAudioBtn').onclick = () => musicPlayer.unlockPlayback();
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
        const settingsWindow = window.open('./settings.html', 'Damuku_music-settings');
        if (!settingsWindow) publicMethod.pageAlert('设置页被浏览器拦截，请允许弹出窗口');
    };

    // 加载歌单
    if (!settingsOnly && liveMode) loginConfiger.loadSongList();
}
// 点歌测试
window.musicPlayer = musicPlayer;
window.orderConfiger = orderConfiger;
window.loginConfiger = loginConfiger;
window.danmuConfiger = danmuConfiger;
