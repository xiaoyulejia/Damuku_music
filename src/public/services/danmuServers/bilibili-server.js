import publicMethod from "../../utils/common.js?v=20260810-4";

/** 使用普通B站直播协议接收弹幕，不再调用直播开放平台 gameStart。 */
export default class BilibiliServer {
    baseUrl = window.API_CONFIG.BASE_PATH + window.API_CONFIG.bili_api;
    socketUrl = "";
    webSocket = null;
    roomId = 0;
    uid = 0;
    timer = null;
    authPacket = null;
    heartPacket = null;
    reconnectCount = 0;
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
        const suppliedToken = params.get('token') || '';
        this.debugLog('连接参数', {
            roomId: this.roomId,
            tokenSource: suppliedToken ? 'url' : 'server',
            api: `${this.baseUrl}/live/danmu-info`,
            debug: this.debug
        });
        if (!this.roomId) {
            publicMethod.pageAlertRepeat("缺少直播间号，请使用 ?roomid=房间号&token=弹幕token");
            return false;
        }

        if (this.historyOnly) {
            this.startHistoryConsole();
            return true;
        }

        let info;
        if (suppliedToken) {
            info = { token: suppliedToken, host_list: [] };
        } else {
            try {
                const response = await axios.get(`${this.baseUrl}/live/danmu-info`, { params: { room_id: this.roomId } });
                if (response.data.code !== 0) throw new Error(response.data.message || '接口返回错误');
                info = response.data.data;
                if (info?._room_id) this.roomId = Number(info._room_id);
                this.debugLog('getDanmuInfo 返回结果', {
                    code: response.data.code,
                    message: response.data.message,
                    tokenLength: info?.token?.length || 0,
                    hostList: info?.host_list || []
                });
            } catch (error) {
                this.debugLog('getDanmuInfo 请求失败', {
                    message: error.message,
                    status: error.response?.status,
                    response: error.response?.data
                });
                console.error('获取弹幕鉴权信息失败:', error);
                publicMethod.pageAlertRepeat("弹幕token获取失败，请检查直播间号或直接传入token");
                return false;
            }
        }

        const host = params.get('host');
        const servers = [...new Set((info.host_list || []).map(item => `wss://${item.host}:${item.wss_port}/sub`))];
        // 对应旧 Dart 项目的 getSocket()：失败后依次尝试 host_list 节点。
        const serverIndex = Math.min(this.reconnectCount, Math.max(servers.length - 1, 0));
        const selectedServer = servers[serverIndex] || 'wss://broadcastlv.chat.bilibili.com:443/sub';
        const upstreamSocketUrl = host
            ? (host.startsWith('ws') ? host : `wss://${host}/sub`)
            : selectedServer;
        // 服务端代理按旧 Dart 项目使用 protover=3 + Brotli，浏览器只接收已解析的JSON。
        const proxyProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const uid = Number(params.get('uid') || 0);
        const proxyParams = new URLSearchParams({ room_id: String(this.roomId), uid: String(uid), token: info.token, host: upstreamSocketUrl });
        if (this.debug) proxyParams.set('debug', '1');
        this.socketUrl = `${proxyProtocol}//${window.location.host}${this.baseUrl}/live/ws?${proxyParams}`;
        this.debugLog('弹幕鉴权信息', {
            tokenLength: info.token?.length || 0,
            tokenAppliedToAuth: Boolean(info.token && proxyParams.get('token')),
            hostCount: servers.length,
            serverIndex,
            hosts: servers,
            upstreamSocketUrl,
            socketUrl: this.socketUrl,
            auth: { roomid: this.roomId, uid, protover: 3, platform: 'web', type: 2 }
        });
        if (this.debug) this.loadHistoryForDebug();

        try {
            this.webSocket = new WebSocket(this.socketUrl);
            this.webSocket.binaryType = 'arraybuffer';
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
                this.debugLog('收到实时弹幕', message);
                if (message.type === 'status') this.debugLog(`代理状态: ${message.status}`, message.detail);
                if (message.type === 'status' && message.status === 'upstream authenticated') this.reconnectCount = 0;
                if (message.type === 'danmu' && message.data) {
                    if (this.debug) console.table([message.data]);
                    if (this.danmuMessage) this.danmuMessage(message.data);
                }
            } catch (error) {
                this.debugLog('实时弹幕JSON解析失败', error);
            }
        };
        this.webSocket.onclose = () => this.reconnectSocket();
        this.webSocket.onerror = () => this.reconnectSocket();
    }

    reconnectSocket() {
        if (this.closing || this.reconnectCount >= 3) {
            if (!this.closing) publicMethod.pageAlertRepeat("重连失败，请确认网络并刷新页面!");
            return;
        }
        this.reconnectCount++;
        publicMethod.pageAlert("连接错误，正在重连...");
        setTimeout(() => this.connect(), 3000);
    }

    handlePacket(packet) {
        if (!packet || packet.byteLength < 16) return 0;
        const view = new DataView(packet);
        const packetLen = view.getUint32(0);
        const headerLen = view.getUint16(4);
        const version = view.getUint16(6);
        const operation = view.getUint32(8);
        this.debugLog('收到数据包', { packetLen, headerLen, version, operation, sequenceId: view.getUint32(12) });
        if (operation === 8) this.debugLog('B站弹幕认证成功');
        if (operation === 3) this.debugLog('收到心跳回复');
        if (packetLen < headerLen || packetLen > packet.byteLength) return 0;
        const body = packet.slice(headerLen, packetLen);
        if (operation !== 5) return packetLen;
        if (version === 0 || version === 1) this.emitMessages(body);
        else if (version === 2) {
            try { this.handleUnzipPacket(pako.inflate(new Uint8Array(body)).buffer); }
            catch (error) { this.debugLog('弹幕zlib解压失败', error); }
        }
        return packetLen;
    }

    // 对应旧 Dart 项目的 _processingData：继续处理同一帧中剩余的数据包。
    handlePacketStream(buffer) {
        let offset = 0;
        while (offset < buffer.byteLength) {
            const length = this.handlePacket(buffer.slice(offset));
            if (!length) break;
            offset += length;
        }
    }

    handleUnzipPacket(buffer) {
        this.handlePacketStream(buffer);
    }

    emitMessages(body) {
        const text = this.textDecoder.decode(new Uint8Array(body)).replace(/\0+$/g, '');
        this.debugLog('解压后的消息文本', text);
        // 一个数据包可能拼接多个JSON，按对象边界拆分。
        const candidates = text.replace(/}\s*{/g, '}\n{').split('\n');
        for (const candidate of candidates) {
            try {
                const message = JSON.parse(candidate);
                this.debugLog('原始弹幕消息', message);
                if (!message.cmd?.startsWith('DANMU_MSG')) continue;
                const info = message.info || [];
                // 参考旧 Dart 项目 controller.dart：info[0][15] 是结构化用户信息。
                const user = info[0]?.[15]?.user;
                const danmu = {
                    uid: user?.uid || info[2]?.[0] || info[2]?.[1] || 0,
                    uname: user?.base?.name || info[2]?.[1] || '用户',
                    danmu: info[1] || ''
                };
                this.debugLog('解析后的弹幕', danmu);
                if (this.debug) console.table([danmu]);
                if (this.danmuMessage) this.danmuMessage(danmu);
            } catch (error) {
                this.debugLog('弹幕JSON解析失败', { error, candidate });
            }
        }
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

    createPacket(content, operation, sequenceId) {
        const bytes = new TextEncoder().encode(content);
        const buffer = new ArrayBuffer(bytes.length + 16);
        const view = new DataView(buffer);
        view.setUint32(0, bytes.length + 16, false);
        view.setUint16(4, 16, false);
        view.setUint16(6, 1, false);
        view.setUint32(8, operation, false);
        view.setUint32(12, sequenceId, false);
        new Uint8Array(buffer, 16).set(bytes);
        return buffer;
    }

    close() {
        this.closing = true;
        this.stopHistoryConsole();
        clearInterval(this.timer);
        this.timer = null;
        if (this.webSocket) {
            this.webSocket.onclose = null;
            this.webSocket.onerror = null;
            this.webSocket.close();
            this.webSocket = null;
        }
    }
}
