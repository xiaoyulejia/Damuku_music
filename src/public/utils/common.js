/* 公用函数 */
export default class PublicMethod {

    // 统一解析集成挂载路径和外部 API 地址。
    static resolveApiBase(apiAddress, basePath = window.API_CONFIG?.BASE_PATH || '') {
        const address = String(apiAddress || '').trim();
        if (!address) return String(basePath || '').replace(/\/$/, '');
        if (/^(https?:|wss?:|\/\/)/i.test(address)) {
            try {
                return new URL(address, window.location.href).toString().replace(/\/$/, '');
            } catch (_) {
                return address.replace(/\/$/, '');
            }
        }
        const joined = [basePath, address].map(value => String(value || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
        return `/${joined}`.replace(/\/+/g, '/');
    }

    static resolveWebSocketBase(apiAddress, basePath = window.API_CONFIG?.BASE_PATH || '') {
        const resolved = PublicMethod.resolveApiBase(apiAddress, basePath);
        if (/^wss?:/i.test(resolved)) return resolved;
        if (/^https?:/i.test(resolved)) return resolved.replace(/^http/i, 'ws');
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}${resolved}`;
    }

    // 页面提示输出
    static pageAlert(str) {
        const normalizedQuery = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        const params = new URLSearchParams(normalizedQuery);
        const liveMode = !['0', 'false', 'no', 'off'].includes((params.get('livemode') || 'true').toLowerCase());
        const configuredShowAlerts = window.__displaySettings?.liveShowAlerts;
        const showAlerts = configuredShowAlerts == null
            ? false
            : Boolean(configuredShowAlerts);
        if (liveMode && !showAlerts) return;
        let alertBox = document.getElementsByClassName("alertBox")[0];
        let text = document.createElement('div');
        text.textContent = str;
        text.className = "text";
        alertBox.appendChild(text);
        setTimeout(function () {
            text.remove();
        }, 7000)
    }

    // 页面提示循环输出
    static pageAlertRepeat(str) {
        setInterval(() => {
            PublicMethod.pageAlert(str);
        }, 7000)
    }

    // 洗牌算法
    static shuffle(array) {
        let currentIndex = array.length, randomIndex;
        while (currentIndex != 0) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex--;
            [array[currentIndex], array[randomIndex]] = [
                array[randomIndex], array[currentIndex]];
        }
        return array;
    }
}
