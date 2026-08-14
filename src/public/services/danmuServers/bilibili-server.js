import publicMethod from "../../utils/common.js?v=20260810-13";

/** 使用普通B站直播协议接收弹幕，不再调用直播开放平台 gameStart。 */
export default class BilibiliServer {
    baseUrl = publicMethod.resolveApiBase(window.API_CONFIG?.bili_api);
    socketUrl = "";
    webSocket = null;
    roomId = 0;
    reconnectCount = 0;
    reconnectTimer = null;
    closing = false;
    textDecoder = new TextDecoder();
    danmuMessage = null;
    debug = false;
    historyOnly = false;
    historyTimer = null;
    historySeen = new Set();
    historyInitialized = false;
    historyPolling = false;

    async connect() {
        this.close();
        this.closing = false;
        // 兼容标准的 &livemode=true，也兼容误写成 ?livemode=true 的链接。
        const normalizedQuery = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
        const params = new URLSearchParams(normalizedQuery);
        this.debug = ['1', 'true', 'yes', 'on'].includes((params.get('debug') || '').toLowerCase());
        const realtime = ['1', 'true', 'yes', 'on'].includes((params.get('realtime') || '').toLowerCase());
        // 默认使用历史弹幕轮询；追加 realtime=1 才启用WebSocket模式。
        this.historyOnly = !realtime || ['1', 'true', 'yes', 'on'].includes((params.get('history') || '').toLowerCase());
        this.roomId = Number(params.get('roomid') || params.get('room_id') || 0);
        this.debugLog('连接参数', {
            roomId: this.roomId,
            mode: this.historyOnly ? 'history' : 'realtime-shared-proxy',
            debug: this.debug
        });
        if (!this.roomId) {
            publicMethod.pageAlertRepeat("缺少直播间号，请使用 ?roomid=房间号");
            return false;
        }

        if (this.historyOnly) {
            this.startHistoryConsole();
            return true;
        }

        // token、Cookie、真实房间号、host轮换和B站上游连接全部由Node房间中心管理。
        // 浏览器只订阅房间，避免敏感token出现在URL和每个页面各建一条B站连接。
        const proxyBase = publicMethod.resolveWebSocketBase(window.API_CONFIG?.bili_api);
        const proxyParams = new URLSearchParams({ room_id: String(this.roomId) });
        if (this.debug) proxyParams.set('debug', '1');
        this.socketUrl = `${proxyBase}/live/ws?${proxyParams}`;
        this.debugLog('共享实时弹幕订阅', { roomId: this.roomId, socketUrl: this.socketUrl });
        if (this.debug) this.loadHistoryForDebug();

        try {
            this.webSocket = new WebSocket(this.socketUrl);
            this.openSocket();
            return true;
        } catch (error) {
            console.error(error);
            publicMethod.pageAlertRepeat("弹幕链接创建失败!");
            return false;
        }
    }

    openSocket() {
        this.webSocket.onopen = () => {
            publicMethod.pageAlert("B站弹幕服务器连接已打开!");
            this.debugLog('WebSocket 已连接');
        };
        this.webSocket.onmessage = event => {
            try {
                const message = JSON.parse(typeof event.data === 'string' ? event.data : this.textDecoder.decode(new Uint8Array(event.data)));
                if (message.type === 'status') this.debugLog(`代理状态: ${message.status}`, message.detail);
                if (message.type === 'status' && message.detail?.roomId) this.roomId = Number(message.detail.roomId);
                if (message.type === 'status' && message.status === 'upstream authenticated') {
                    this.reconnectCount = 0;
                    if (this.debug) {
                        console.log(`[BilibiliDanmu][WebSocket] 实时弹幕认证成功，房间 ${message.detail?.roomId || this.roomId}`);
                    }
                }
                if (message.type === 'danmu' && message.data) {
                    if (this.debug) {
                        const receivedAt = Number(message.data.receivedAt) || Date.now();
                        const time = new Date(receivedAt).toLocaleTimeString();
                        console.log(
                            `[BilibiliDanmu][WebSocket实时弹幕] ${time} 房间 ${message.data.roomId || this.roomId} ` +
                            `${message.data.uname || '用户'}(${message.data.uid || 0}): ${message.data.danmu || ''}`,
                            message.data
                        );
                    }
                    if (this.danmuMessage) this.danmuMessage(message.data);
                }
                if (message.type === 'error') {
                    console.error('[BilibiliDanmu][WebSocket] 实时弹幕代理错误:', message.code, message.message);
                    publicMethod.pageAlertRepeat(`实时弹幕连接失败：${message.message || message.code || '未知错误'}`);
                }
            } catch (error) {
                this.debugLog('实时弹幕JSON解析失败', error);
            }
        };
        this.webSocket.onclose = () => this.reconnectSocket();
        // 浏览器会在 error 后继续触发 close，只由 close 安排重连，避免一次故障重连两次。
        this.webSocket.onerror = error => this.debugLog('WebSocket 错误，等待 close 后重连', error);
    }

    reconnectSocket() {
        if (this.closing || this.reconnectTimer || this.reconnectCount >= 3) {
            if (!this.closing) publicMethod.pageAlertRepeat("重连失败，请确认网络并刷新页面!");
            return;
        }
        this.reconnectCount++;
        publicMethod.pageAlert("连接错误，正在重连...");
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 3000);
    }

    async loadHistoryForDebug() {
        try {
            const response = await axios.get(`${this.baseUrl}/live/danmu-history`, {
                params: { room_id: this.roomId }
            });
            const history = response.data?.data?.room || [];
            const parsed = history.map(item => ({
                uid: item.uid || item.user?.uid || 0,
                uname: item.user?.base?.name || item.uname || item.nickname || '用户',
                danmu: item.text || ''
            }));
            this.debugLog('gethistory 返回原始数据', response.data);
            this.debugLog('gethistory 解析后的历史弹幕（不会触发点歌）', parsed);
            if (parsed.length) console.table(parsed);
        } catch (error) {
            this.debugLog('gethistory 请求失败', {
                message: error.message,
                status: error.response?.status,
                response: error.response?.data
            });
        }
    }

    startHistoryConsole() {
        this.stopHistoryConsole();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.historySeen.clear();
        this.historyInitialized = false;
        const poll = async () => {
            if (this.historyPolling) return;
            this.historyPolling = true;
            try {
                const response = await axios.get(`${this.baseUrl}/live/danmu-history`, {
                    params: { room_id: this.roomId },
                    headers: { 'cache-control': 'no-cache' }
                });
                if (response.data?.data?._room_id) this.roomId = Number(response.data.data._room_id);
                const items = response.data?.data?.room || [];
                const keyOf = item => item.id_str || [item.uid, item.timeline, item.text].join('|');
                const freshItems = items.filter(item => !this.historySeen.has(keyOf(item)));
                items.forEach(item => this.historySeen.add(keyOf(item)));
                if (!this.historyInitialized) {
                    this.historyInitialized = true;
                    console.log(`[BilibiliDanmu][history] 已建立基线：房间 ${this.roomId} 当前 ${items.length} 条，旧弹幕不会触发点歌`);
                } else if (freshItems.length) {
                    const rows = freshItems.map(item => ({
                        time: item.timeline || '-',
                        uid: item.uid || item.user?.uid || 0,
                        uname: item.user?.base?.name || item.uname || item.nickname || '用户',
                        danmu: item.text || '',
                        id: item.id_str || '-'
                    }));
                    console.log(`[BilibiliDanmu][history] 发现 ${rows.length} 条更新弹幕`);
                    console.table(rows);
                    for (const item of freshItems) {
                        if (this.danmuMessage) this.danmuMessage({
                            uid: item.uid || item.user?.uid || 0,
                            uname: item.user?.base?.name || item.uname || item.nickname || '用户',
                            danmu: item.text || ''
                        });
                    }
                }
                if (this.historySeen.size > 500) this.historySeen = new Set([...this.historySeen].slice(-200));
            } catch (error) {
                console.error('[BilibiliDanmu][history] 请求失败:', error.response?.data || error.message);
            } finally {
                this.historyPolling = false;
            }
        };
        poll();
        this.historyTimer = setInterval(poll, 3000);
        console.log(`[BilibiliDanmu][history] 已启动：每3秒轮询房间 ${this.roomId} 的最近10条弹幕，新弹幕会交给点歌逻辑`);
    }

    stopHistoryConsole() {
        if (this.historyTimer) clearInterval(this.historyTimer);
        this.historyTimer = null;
    }

    debugLog(label, value) {
        if (!this.debug) return;
        if (typeof value === 'undefined') console.debug(`[BilibiliDanmu][debug] ${label}`);
        else console.debug(`[BilibiliDanmu][debug] ${label}`, value);
    }

    close() {
        this.closing = true;
        this.stopHistoryConsole();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.webSocket) {
            this.webSocket.onclose = null;
            this.webSocket.onerror = null;
            this.webSocket.close();
            this.webSocket = null;
        }
    }
}
