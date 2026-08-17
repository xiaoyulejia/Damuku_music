const crypto = require('crypto');
const WebSocket = require('ws');
const zlib = require('zlib');
const { getBiliSession } = require('./bili-session');

const HEADER_SIZE = 16;
const MAX_PACKET_SIZE = 16 * 1024 * 1024;
const HEARTBEAT_MS = 30 * 1000;
const AUTH_TIMEOUT_MS = 12 * 1000;
const IDLE_CLOSE_MS = 45 * 1000;
const METRICS_INTERVAL_MS = 10 * 1000;
const RECENT_EVENT_TTL_MS = 5 * 60 * 1000;
const RECENT_EVENT_LIMIT = 5000;

function createQueueUuid() {
    return Math.random().toString(36).slice(-8).padStart(8, '0');
}

function packet(body, operation, sequence = 1) {
    const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const result = Buffer.alloc(HEADER_SIZE + content.length);
    result.writeUInt32BE(result.length, 0);
    result.writeUInt16BE(HEADER_SIZE, 4);
    result.writeUInt16BE(1, 6);
    result.writeUInt32BE(operation, 8);
    result.writeUInt32BE(sequence, 12);
    content.copy(result, HEADER_SIZE);
    return result;
}

function parseMessages(buffer, callback) {
    let offset = 0;
    while (offset + HEADER_SIZE <= buffer.length) {
        const total = buffer.readUInt32BE(offset);
        const header = buffer.readUInt16BE(offset + 4);
        const version = buffer.readUInt16BE(offset + 6);
        const operation = buffer.readUInt32BE(offset + 8);
        const sequence = buffer.readUInt32BE(offset + 12);
        if (header < HEADER_SIZE || total < header || total > MAX_PACKET_SIZE) {
            throw new Error(`invalid danmu packet: total=${total}, header=${header}`);
        }
        if (offset + total > buffer.length) break;
        const body = buffer.subarray(offset + header, offset + total);
        callback({ total, header, version, operation, sequence, body });
        offset += total;
    }
    return buffer.subarray(offset);
}

function decodeBody(body, version) {
    if (version === 2) return zlib.inflateSync(body);
    if (version === 3) return zlib.brotliDecompressSync(body);
    return body;
}

function extractJsonObjects(text) {
    const result = [];
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"' && start >= 0) {
            quoted = true;
            continue;
        }
        if (char === '{') {
            if (start < 0) start = i;
            depth++;
        } else if (char === '}' && start >= 0) {
            depth--;
            if (depth === 0) {
                result.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return result;
}

function parseExtra(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value) return {};
    try {
        return JSON.parse(value);
    } catch (_) {
        return {};
    }
}

function normalizeEpoch(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
    return timestamp >= 1e12 ? Math.floor(timestamp) : Math.floor(timestamp * 1000);
}

function anonymousUid(userHash) {
    if (!userHash) return 0;
    const numeric = Number(userHash);
    if (Number.isSafeInteger(numeric) && numeric > 0) return -numeric;
    return -(crypto.createHash('sha1').update(String(userHash)).digest().readUInt32BE(0) + 1);
}

function normalizeDanmu(message, roomId, options = {}) {
    const command = String(message?.cmd || '').split(':', 1)[0];
    if (command !== 'DANMU_MSG') return null;
    const info = Array.isArray(message.info) ? message.info : [];
    const metadata = info[0]?.[15] || {};
    const user = metadata.user;
    const extra = parseExtra(metadata.extra);
    const sentAt = normalizeEpoch(info[0]?.[4] ?? extra.ts ?? 0);
    const userHash = String(extra.user_hash ?? '');
    const exposedUid = Number(user?.uid ?? info[2]?.[0] ?? 0) || 0;
    return {
        // 当前匿名网页流会把真实 uid 置 0；使用负数伪 UID 区分用户，避免所有人共享点歌限额。
        uid: exposedUid || anonymousUid(userHash),
        uname: String(user?.base?.name ?? info[2]?.[1] ?? '用户'),
        danmu: String(info[1] ?? ''),
        roomId: Number(roomId),
        messageId: String(extra.id_str ?? extra.id ?? metadata.id_str ?? ''),
        sentAt,
        receivedAt: Date.now(),
        source: options.source || 'websocket',
        connectionId: options.connectionId || '',
        rnd: String(info[0]?.[5] ?? extra.rnd ?? ''),
        userHash
    };
}

function normalizeHistoryDanmu(item, roomId, connectionId) {
    const timeline = item?.timeline ? Date.parse(item.timeline.replace(/-/g, '/')) : 0;
    return {
        uid: Number(item?.uid ?? item?.user?.uid ?? 0) || 0,
        uname: String(item?.user?.base?.name ?? item?.uname ?? item?.nickname ?? '用户'),
        danmu: String(item?.text ?? ''),
        roomId: Number(roomId),
        messageId: String(item?.id_str ?? item?.id ?? ''),
        sentAt: Number.isFinite(timeline) ? timeline : 0,
        receivedAt: Date.now(),
        source: 'history-recovery',
        connectionId,
        rnd: String(item?.rnd ?? '')
    };
}

function eventFingerprint(event) {
    if (event.messageId) return `id:${event.messageId}`;
    const stableTime = event.sentAt ? Math.floor(event.sentAt / 1000) : Math.floor(event.receivedAt / 1000);
    const source = [event.roomId, event.uid, stableTime, event.rnd, event.danmu].join('|');
    return `fallback:${crypto.createHash('sha1').update(source).digest('base64url')}`;
}

function parseJsonPayload(buffer, onMessage, onError = () => {}) {
    const decoded = buffer.toString('utf8').replace(/^\0+/, '').replace(/\0+$/g, '').trim();
    for (const candidate of extractJsonObjects(decoded)) {
        try {
            onMessage(JSON.parse(candidate));
        } catch (error) {
            onError(error, candidate.slice(0, 200));
        }
    }
}

function decodeDanmuBody(version, body, callbacks = {}) {
    const onMessage = callbacks.onMessage || (() => {});
    const onPacket = callbacks.onPacket || (() => {});
    const onError = callbacks.onError || (() => {});
    if (version === 0 || version === 1) {
        parseJsonPayload(body, onMessage, onError);
        return;
    }
    if (version !== 2 && version !== 3) throw new Error(`unsupported danmu protocol version: ${version}`);

    const decompressed = decodeBody(body, version);
    callbacks.onDecompressed?.({ version, compressedLength: body.length, decompressedLength: decompressed.length });
    const text = decompressed.toString('utf8').replace(/^\0+/, '').trimStart();
    if (text.startsWith('{') || text.startsWith('[')) {
        parseJsonPayload(decompressed, onMessage, onError);
        return;
    }

    const remainder = parseMessages(decompressed, inner => {
        onPacket(inner);
        if (inner.operation === 5) decodeDanmuBody(inner.version, inner.body, callbacks);
    });
    if (remainder.length) throw new Error(`incomplete nested danmu packet: remainder=${remainder.length}`);
}

// 保留旧的纯函数接口，便于协议单元测试和其他本地调用方使用。
function processDanmuPacket(version, body, browserSocket, notify, roomId) {
    decodeDanmuBody(version, body, {
        onMessage(message) {
            const danmu = normalizeDanmu(message, roomId);
            if (!danmu) return;
            notify('DANMU_MSG', { uid: danmu.uid, uname: danmu.uname, danmu: danmu.danmu });
            if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(JSON.stringify({ type: 'danmu', data: danmu }));
        },
        onPacket(inner) {
            notify('Brotli内层数据包已解析', {
                version: inner.version,
                operation: inner.operation,
                bodyLength: inner.body.length
            });
        },
        onDecompressed(detail) {
            notify('Brotli解压完成', detail);
        },
        onError(error, preview) {
            notify('JSON parse failed', { message: error.message, preview });
        }
    });
}

class StatefulDanmuDecoder {
    constructor(onPacket) {
        this.onPacket = onPacket;
        this.remainder = Buffer.alloc(0);
    }

    push(chunk) {
        const incoming = Buffer.from(chunk);
        if (this.remainder.length + incoming.length > MAX_PACKET_SIZE) {
            this.reset();
            throw new Error('danmu outer buffer exceeds 16 MiB');
        }
        const combined = this.remainder.length ? Buffer.concat([this.remainder, incoming]) : incoming;
        this.remainder = parseMessages(combined, this.onPacket);
        return this.remainder.length;
    }

    reset() {
        this.remainder = Buffer.alloc(0);
    }
}

class RoomConnection {
    constructor(info, options = {}) {
        this.session = options.session || getBiliSession();
        this.WebSocketImpl = options.WebSocketImpl || WebSocket;
        this.onDisposed = options.onDisposed || (() => {});
        this.roomId = info.roomId;
        this.uid = info.uid;
        this.token = info.token;
        this.hosts = info.hosts;
        this.subscribers = new Map();
        this.connectionId = '';
        this.state = 'IDLE';
        this.upstream = null;
        this.hostIndex = 0;
        this.connectAttempt = 0;
        this.failureStreak = 0;
        this.heartbeatSequence = 1;
        this.queueUuid = createQueueUuid();
        this.pendingAckSequence = 0;
        this.lastAckedSequence = 0;
        this.ackInFlight = false;
        this.ackGeneration = 0;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.authTimer = null;
        this.metricsTimer = null;
        this.idleTimer = null;
        this.disposed = false;
        this.wasAuthenticated = false;
        this.needsRecovery = false;
        this.disconnectedAt = 0;
        this.recentEvents = new Map();
        this.metrics = this.createMetrics();
        this.decoder = new StatefulDanmuDecoder(protocolPacket => this.handleProtocolPacket(protocolPacket));
    }

    createMetrics() {
        return {
            connectionId: this.connectionId,
            roomId: this.roomId,
            upstreamHost: '',
            connectedAt: 0,
            reconnectCount: 0,
            wsMessageCount: 0,
            outerPacketCount: 0,
            compressedPacketCount: 0,
            innerPacketCount: 0,
            commandCountByType: {},
            danmuDecodedCount: 0,
            proxySentCount: 0,
            subscriberDeliveryCount: 0,
            parseErrorCount: 0,
            decompressErrorCount: 0,
            remainderBytes: 0,
            lastProtocolSequence: 0,
            lastMessageSequence: 0,
            lastAckedSequence: 0,
            httpAckAttemptCount: 0,
            httpAckSuccessCount: 0,
            httpAckFailureCount: 0,
            socketAckCount: 0,
            lastDanmuAt: 0,
            lastHeartbeatReplyAt: 0
        };
    }

    subscribe(socket, options = {}) {
        if (this.disposed) throw new Error('room connection is closed');
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
        const debug = Boolean(options.debug);
        this.subscribers.set(socket, { debug });
        if (debug) {
            console.log('[BilibiliDanmu][realtime] 已订阅实时模式', {
                roomId: this.roomId,
                connectionId: this.connectionId || null,
                subscribers: this.subscribers.size
            });
        }
        this.send(socket, {
            type: 'status',
            status: 'room subscribed',
            detail: {
                roomId: this.roomId,
                state: this.state,
                connectionId: this.connectionId,
                mode: 'realtime-websocket'
            }
        });
        if (this.state === 'IDLE' || this.state === 'BACKOFF') this.start();
    }

    unsubscribe(socket) {
        this.subscribers.delete(socket);
        if (!this.subscribers.size && !this.idleTimer) {
            this.idleTimer = setTimeout(() => this.dispose(), IDLE_CLOSE_MS);
            this.idleTimer.unref?.();
        }
    }

    start() {
        if (this.disposed || this.upstream || this.reconnectTimer) return;
        this.startMetrics();
        this.connect().catch(error => this.scheduleReconnect(error));
    }

    async refreshConnectionInfo() {
        const info = await this.session.getDanmuInfo(this.roomId, { force: true });
        this.roomId = info.roomId;
        this.uid = info.uid;
        this.token = info.token;
        this.hosts = info.hosts;
        this.hostIndex %= this.hosts.length;
    }

    async connect() {
        if (this.disposed || this.upstream) return;
        if (!this.hosts.length || (this.connectAttempt > 0 && this.connectAttempt % this.hosts.length === 0)) {
            await this.refreshConnectionInfo();
        }
        const host = this.hosts[this.hostIndex % this.hosts.length];
        this.hostIndex = (this.hostIndex + 1) % this.hosts.length;
        this.connectAttempt++;
        this.connectionId = `${this.roomId}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        this.ackGeneration++;
        this.pendingAckSequence = 0;
        this.lastAckedSequence = 0;
        this.ackInFlight = false;
        this.state = 'CONNECTING';
        this.metrics.connectionId = this.connectionId;
        this.metrics.lastAckedSequence = 0;
        this.metrics.upstreamHost = host;
        this.metrics.reconnectCount = Math.max(0, this.connectAttempt - 1);
        this.decoder.reset();
        this.broadcastStatus('upstream connecting', { roomId: this.roomId, connectionId: this.connectionId, hostIndex: this.hostIndex }, true);

        const upstream = new this.WebSocketImpl(host, {
            headers: { Origin: 'https://live.bilibili.com', Referer: `https://live.bilibili.com/${this.roomId}` }
        });
        this.upstream = upstream;
        upstream.on('open', () => {
            if (upstream !== this.upstream || this.disposed) return;
            this.state = 'AUTHENTICATING';
            upstream.send(packet(JSON.stringify({
                roomid: this.roomId,
                uid: this.uid,
                protover: 3,
                buvid: this.session.getBuvid3?.() || '',
                support_ack: true,
                queue_uuid: this.queueUuid,
                scene: 'room',
                platform: 'web',
                type: 2,
                key: this.token
            }), 7));
            clearTimeout(this.authTimer);
            this.authTimer = setTimeout(() => this.failCurrentConnection('B站弹幕认证超时'), AUTH_TIMEOUT_MS);
            this.authTimer.unref?.();
        });
        upstream.on('message', data => {
            if (upstream !== this.upstream || this.disposed) return;
            this.metrics.wsMessageCount++;
            try {
                this.metrics.remainderBytes = this.decoder.push(data);
            } catch (error) {
                this.metrics.parseErrorCount++;
                this.debugLog('decode failed', { message: error.message, bytes: Buffer.byteLength(data) });
                this.failCurrentConnection('B站弹幕数据解析失败');
            }
        });
        upstream.on('error', error => {
            if (upstream !== this.upstream) return;
            this.debugLog('upstream error', { message: error.message });
        });
        upstream.on('close', (code, reason) => {
            if (upstream !== this.upstream) return;
            this.upstream = null;
            this.clearConnectionTimers();
            if (this.wasAuthenticated) {
                this.needsRecovery = true;
                this.disconnectedAt = Date.now();
            }
            this.scheduleReconnect(new Error(`上游关闭 code=${code} reason=${reason?.toString() || '-'}`));
        });
    }

    handleProtocolPacket(protocolPacket) {
        this.metrics.outerPacketCount++;
        this.metrics.lastProtocolSequence = protocolPacket.sequence;
        if (protocolPacket.operation === 3) {
            this.metrics.lastHeartbeatReplyAt = Date.now();
            return;
        }
        if (protocolPacket.operation === 8) {
            this.onAuthenticated(protocolPacket);
            return;
        }
        if (protocolPacket.operation !== 5) return;
        this.metrics.lastMessageSequence = protocolPacket.sequence;
        try {
            if (protocolPacket.version === 2 || protocolPacket.version === 3) this.metrics.compressedPacketCount++;
            decodeDanmuBody(protocolPacket.version, protocolPacket.body, {
                onPacket: inner => {
                    this.metrics.innerPacketCount++;
                    this.metrics.lastProtocolSequence = inner.sequence;
                },
                onMessage: message => this.handleMessage(message),
                onError: (error, preview) => {
                    this.metrics.parseErrorCount++;
                    this.debugLog('JSON parse failed', { message: error.message, preview });
                }
            });
            this.queueHttpAck(protocolPacket.sequence);
        } catch (error) {
            this.metrics.decompressErrorCount++;
            throw error;
        }
    }

    onAuthenticated(protocolPacket) {
        if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
        try {
            const auth = JSON.parse(protocolPacket.body.toString('utf8') || '{}');
            if (Number(auth.code) !== 0) {
                this.metrics.parseErrorCount++;
                this.failCurrentConnection(`B站弹幕认证失败 code=${auth.code}`);
                return;
            }
        } catch (error) {
            this.metrics.parseErrorCount++;
            this.failCurrentConnection(`B站弹幕认证响应无效: ${error.message}`);
            return;
        }
        clearTimeout(this.authTimer);
        this.authTimer = null;
        this.state = 'LIVE';
        this.wasAuthenticated = true;
        this.failureStreak = 0;
        this.metrics.connectedAt = Date.now();
        this.sendHeartbeat();
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
        this.heartbeatTimer.unref?.();
        this.broadcastStatus('upstream authenticated', {
            roomId: this.roomId,
            connectionId: this.connectionId,
            version: protocolPacket.version,
            session: this.session.diagnostics()
        }, true);
        if (this.needsRecovery) {
            this.needsRecovery = false;
            this.recoverHistory().catch(error => this.debugLog('history recovery failed', { message: error.message }));
        }
    }

    sendHeartbeat() {
        if (this.upstream?.readyState === WebSocket.OPEN) {
            this.upstream.send(packet('', 2, this.heartbeatSequence++));
        }
    }

    handleMessage(message) {
        const command = String(message?.cmd || '').split(':', 1)[0] || 'UNKNOWN';
        this.metrics.commandCountByType[command] = (this.metrics.commandCountByType[command] || 0) + 1;
        this.sendSocketAck(message);
        const event = normalizeDanmu(message, this.roomId, {
            source: 'websocket',
            connectionId: this.connectionId
        });
        if (!event) return;
        this.metrics.danmuDecodedCount++;
        this.metrics.lastDanmuAt = Date.now();
        this.debugLog('收到实时弹幕', {
            uid: event.uid,
            uname: event.uname,
            danmu: event.danmu,
            messageId: event.messageId
        });
        this.publishEvent(event);
    }

    sendSocketAck(message) {
        if (!message?.msg_id || !message?.p_is_ack || this.upstream?.readyState !== WebSocket.OPEN) return false;
        const body = JSON.stringify({
            msg_id: message.msg_id,
            cmd: message.cmd,
            p_msg_type: Number(message.p_msg_type) || 0
        });
        try {
            this.upstream.send(packet(body, 24));
            this.metrics.socketAckCount++;
            return true;
        } catch (error) {
            this.debugLog('socket ACK failed', { message: error.message });
            return false;
        }
    }

    queueHttpAck(sequence) {
        const normalized = Number(sequence);
        if (!Number.isInteger(normalized) || normalized <= 1 || normalized <= this.lastAckedSequence) return;
        this.pendingAckSequence = Math.max(this.pendingAckSequence, normalized);
        this.drainHttpAck();
    }

    drainHttpAck() {
        if (this.ackInFlight || this.pendingAckSequence <= this.lastAckedSequence) return;
        const sequence = this.pendingAckSequence;
        const generation = this.ackGeneration;
        this.pendingAckSequence = 0;
        this.ackInFlight = true;
        this.metrics.httpAckAttemptCount++;
        Promise.resolve(this.session.acknowledgeMessages?.(sequence))
            .then(() => {
                if (generation !== this.ackGeneration) return;
                this.lastAckedSequence = Math.max(this.lastAckedSequence, sequence);
                this.metrics.lastAckedSequence = this.lastAckedSequence;
                this.metrics.httpAckSuccessCount++;
            })
            .catch(error => {
                if (generation !== this.ackGeneration) return;
                this.metrics.httpAckFailureCount++;
                this.debugLog('HTTP ACK failed', { sequence, message: error.message });
            })
            .finally(() => {
                if (generation !== this.ackGeneration) return;
                this.ackInFlight = false;
                if (this.pendingAckSequence > this.lastAckedSequence) this.drainHttpAck();
            });
    }

    publishEvent(event) {
        const fingerprint = eventFingerprint(event);
        if (this.recentEvents.has(fingerprint)) return false;
        this.remember(fingerprint);
        let sent = 0;
        for (const socket of this.subscribers.keys()) {
            if (this.send(socket, { type: 'danmu', data: { ...event, fingerprint } })) sent++;
        }
        if (sent > 0) this.metrics.proxySentCount++;
        this.metrics.subscriberDeliveryCount += sent;
        return true;
    }

    remember(fingerprint) {
        const now = Date.now();
        this.recentEvents.set(fingerprint, now);
        if (this.recentEvents.size <= RECENT_EVENT_LIMIT) return;
        for (const [key, createdAt] of this.recentEvents) {
            if (createdAt < now - RECENT_EVENT_TTL_MS || this.recentEvents.size > RECENT_EVENT_LIMIT) this.recentEvents.delete(key);
            if (this.recentEvents.size <= RECENT_EVENT_LIMIT) break;
        }
    }

    async recoverHistory() {
        const history = await this.session.getHistory(this.roomId);
        let recovered = 0;
        const events = history.items
            .map(item => normalizeHistoryDanmu(item, this.roomId, this.connectionId))
            .filter(item => item.danmu && item.sentAt && (!this.disconnectedAt || item.sentAt >= this.disconnectedAt - 5000))
            .sort((left, right) => left.sentAt - right.sentAt);
        for (const event of events) if (this.publishEvent(event)) recovered++;
        this.disconnectedAt = 0;
        this.broadcastStatus('history recovery complete', { roomId: this.roomId, checked: events.length, recovered }, false);
    }

    failCurrentConnection(reason) {
        this.broadcastStatus('upstream unhealthy', { roomId: this.roomId, reason }, true);
        const upstream = this.upstream;
        if (!upstream) return;
        try {
            upstream.terminate?.();
            if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
        } catch (_) {
            this.upstream = null;
            this.scheduleReconnect(new Error(reason));
        }
    }

    scheduleReconnect(error) {
        if (this.disposed || this.reconnectTimer) return;
        this.upstream = null;
        this.clearConnectionTimers();
        this.state = 'BACKOFF';
        this.queueUuid = createQueueUuid();
        const exponent = Math.min(5, this.failureStreak++);
        const delay = Math.min(30000, 1000 * (2 ** exponent)) + Math.floor(Math.random() * 500);
        this.broadcastStatus('upstream reconnect scheduled', {
            roomId: this.roomId,
            delay,
            reason: error.message,
            nextHostIndex: this.hostIndex
        }, true);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch(connectError => this.scheduleReconnect(connectError));
        }, delay);
        this.reconnectTimer.unref?.();
    }

    startMetrics() {
        if (this.metricsTimer) return;
        this.metricsTimer = setInterval(() => {
            this.metrics.remainderBytes = this.decoder.remainder.length;
            const snapshot = this.metricsSnapshot();
            if ([...this.subscribers.values()].some(item => item.debug)) {
                console.log('[BilibiliDanmu][metrics]', snapshot);
                this.broadcastStatus('metrics', snapshot, false);
            }
        }, METRICS_INTERVAL_MS);
        this.metricsTimer.unref?.();
    }

    metricsSnapshot() {
        return {
            ...this.metrics,
            state: this.state,
            mode: 'realtime-websocket',
            subscribers: this.subscribers.size,
            commandCountByType: { ...this.metrics.commandCountByType }
        };
    }

    broadcastStatus(status, detail, force) {
        for (const [socket, options] of this.subscribers) {
            if (force || options.debug) this.send(socket, { type: 'status', status, detail });
        }
    }

    debugLog(status, detail) {
        if ([...this.subscribers.values()].some(item => item.debug)) {
            console.debug(`[BilibiliDanmu][proxy] ${status}`, { roomId: this.roomId, connectionId: this.connectionId, ...detail });
        }
    }

    send(socket, payload) {
        if (socket.readyState !== WebSocket.OPEN) return false;
        try {
            socket.send(JSON.stringify(payload));
            return true;
        } catch (_) {
            return false;
        }
    }

    clearConnectionTimers() {
        clearInterval(this.heartbeatTimer);
        clearTimeout(this.authTimer);
        this.heartbeatTimer = null;
        this.authTimer = null;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.state = 'CLOSED';
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.idleTimer);
        clearInterval(this.metricsTimer);
        this.clearConnectionTimers();
        this.reconnectTimer = null;
        this.idleTimer = null;
        this.metricsTimer = null;
        const upstream = this.upstream;
        this.upstream = null;
        try {
            upstream?.close();
        } catch (error) {
            this.debugLog('upstream close failed', { message: error.message });
        }
        this.subscribers.clear();
        this.onDisposed(this);
    }
}

class LiveDanmuHub {
    constructor(options = {}) {
        this.session = options.session || getBiliSession();
        this.WebSocketImpl = options.WebSocketImpl || WebSocket;
        this.rooms = new Map();
        this.aliases = new Map();
        this.pending = new Map();
    }

    async getRoom(requestedRoomId) {
        const requested = Number(requestedRoomId);
        const knownReal = this.aliases.get(requested) || requested;
        if (this.rooms.has(knownReal)) return this.rooms.get(knownReal);
        if (this.pending.has(requested)) return this.pending.get(requested);

        const pending = this.session.getDanmuInfo(requested).then(info => {
            const existing = this.rooms.get(info.roomId);
            if (existing) {
                this.aliases.set(requested, info.roomId);
                return existing;
            }
            const room = new RoomConnection(info, {
                session: this.session,
                WebSocketImpl: this.WebSocketImpl,
                onDisposed: disposed => this.removeRoom(disposed)
            });
            this.rooms.set(info.roomId, room);
            this.aliases.set(requested, info.roomId);
            this.aliases.set(info.roomId, info.roomId);
            return room;
        }).finally(() => this.pending.delete(requested));
        this.pending.set(requested, pending);
        return pending;
    }

    async subscribe(requestedRoomId, socket, options = {}) {
        try {
            const room = await this.getRoom(requestedRoomId);
            if (socket.readyState !== WebSocket.OPEN) return;
            room.subscribe(socket, options);
            socket.once('close', () => room.unsubscribe(socket));
            socket.once('error', () => room.unsubscribe(socket));
        } catch (error) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'error', code: 'UPSTREAM_SETUP_FAILED', message: error.message }));
                socket.close(1011, 'Bilibili upstream setup failed');
            }
        }
    }

    removeRoom(room) {
        if (this.rooms.get(room.roomId) === room) this.rooms.delete(room.roomId);
        for (const [alias, real] of this.aliases) if (real === room.roomId) this.aliases.delete(alias);
    }

    dispose() {
        for (const room of [...this.rooms.values()]) room.dispose();
        this.rooms.clear();
        this.aliases.clear();
    }

    metricsFor(roomId) {
        const requested = Number(roomId);
        const real = this.aliases.get(requested) || requested;
        return this.rooms.get(real)?.metricsSnapshot() || null;
    }
}

let attachedHub = null;

function getAttachedLiveDanmuHub() {
    return attachedHub;
}

function attachLiveProxy(server, basePath, biliPath, options = {}) {
    const wssPath = `${basePath}${biliPath}/live/ws`;
    const hub = options.hub || new LiveDanmuHub(options);
    attachedHub = hub;
    const wss = new WebSocket.Server({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname !== wssPath) return;
        const roomId = Number(url.searchParams.get('room_id') || url.searchParams.get('roomid'));
        if (!Number.isInteger(roomId) || roomId <= 0) {
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, browserSocket => {
            const debug = ['1', 'true', 'yes', 'on'].includes(
                String(url.searchParams.get('debug') || '').toLowerCase()
            );
            hub.subscribe(roomId, browserSocket, { debug });
        });
    });
    server.once('close', () => {
        hub.dispose();
        if (attachedHub === hub) attachedHub = null;
        wss.close();
    });
    return hub;
}

module.exports = {
    LiveDanmuHub,
    RoomConnection,
    StatefulDanmuDecoder,
    attachLiveProxy,
    decodeDanmuBody,
    eventFingerprint,
    extractJsonObjects,
    normalizeDanmu,
    normalizeHistoryDanmu,
    getAttachedLiveDanmuHub,
    packet,
    parseMessages,
    processDanmuPacket
};
