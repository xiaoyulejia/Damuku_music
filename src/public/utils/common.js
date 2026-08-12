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

    // 加载配置项
    static readConfig(obj) {
        // 根据字段名读取配置项
        for (const key in obj) {
            if (!localStorage.getItem(key)) {
                continue;
            }
            if (typeof obj[key] == "string") {
                // 字符串类型配置项
                obj[key] = localStorage.getItem(key);
            } else if (typeof obj[key] == "number") {
                // 数字类型配置项
                obj[key] = parseInt(localStorage.getItem(key));
            } else if (typeof obj[key] == "object" || Array.isArray(obj[key])) {
                // 对象和数组
                obj[key] = JSON.parse(localStorage.getItem(key));
            }
            // 其他为function类型
        }
    }

    // 页面提示输出
    static pageAlert(str) {
        const normalizedQuery = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        const params = new URLSearchParams(normalizedQuery);
        const liveMode = !['0', 'false', 'no', 'off'].includes((params.get('livemode') || 'true').toLowerCase());
        const showAlerts = ['1', 'true', 'yes', 'on'].includes((localStorage.getItem('liveShowAlerts') || 'false').toLowerCase());
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
