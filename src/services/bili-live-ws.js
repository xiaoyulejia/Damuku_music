const WebSocket = require('ws');
const zlib = require('zlib');

const HEADER_SIZE = 16;
const MAX_PACKET_SIZE = 16 * 1024 * 1024;

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

function normalizeDanmu(message, roomId) {
    const command = String(message?.cmd || '').split(':', 1)[0];
    if (command !== 'DANMU_MSG') return null;
    const info = message.info || [];
    const user = info[0]?.[15]?.user;
    return {
        uid: Number(user?.uid ?? info[2]?.[0] ?? 0) || 0,
        uname: String(user?.base?.name ?? info[2]?.[1] ?? '用户'),
        danmu: String(info[1] ?? ''),
        roomId,
        receivedAt: Date.now()
    };
}

function forwardJsonPayload(buffer, browserSocket, notify, roomId) {
    const decoded = buffer.toString('utf8').replace(/^\0+/, '').replace(/\0+$/g, '').trim();
    for (const candidate of extractJsonObjects(decoded)) {
        try {
            const message = JSON.parse(candidate);
            const danmu = normalizeDanmu(message, roomId);
            if (!danmu) continue;
            notify('DANMU_MSG', { uid: danmu.uid, uname: danmu.uname, danmu: danmu.danmu });
            if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(JSON.stringify({ type: 'danmu', data: danmu, raw: message }));
        } catch (error) {
            notify('JSON parse failed', { message: error.message, preview: candidate.slice(0, 200) });
        }
    }
}

// 与旧 Dart 项目 LiveMessageStream.onData 的协议分支保持一致。
function processDanmuPacket(version, body, browserSocket, notify, roomId) {
    if (version === 0 || version === 1) {
        // Dart: _processingData(data) -> utf8.decode(data.sublist(headerSize, totalSize))
        forwardJsonPayload(body, browserSocket, notify, roomId);
        return;
    }

    const decompressed = decodeBody(body, version);
    const decompressedText = decompressed.toString('utf8').replace(/^\0+/, '').trimStart();
    notify('Brotli解压完成', {
        version,
        compressedLength: body.length,
        decompressedLength: decompressed.length,
        firstBytes: [...decompressed.subarray(0, 16)],
        startsWithJson: decompressedText.startsWith('{') || decompressedText.startsWith('[')
    });
    if (decompressedText.startsWith('{') || decompressedText.startsWith('[')) {
        forwardJsonPayload(decompressed, browserSocket, notify, roomId);
        return;
    }
    if (decompressed.length >= 16) {
        notify('Brotli内层数据包', {
            total: decompressed.readUInt32BE(0),
            header: decompressed.readUInt16BE(4),
            version: decompressed.readUInt16BE(6),
            operation: decompressed.readUInt32BE(8),
            sequence: decompressed.readUInt32BE(12),
            bufferLength: decompressed.length
        });
    }
    parseMessages(decompressed, ({ version: nestedVersion, operation: nestedOperation, body: nestedBody }) => {
        notify('Brotli内层数据包已解析', {
            version: nestedVersion,
            operation: nestedOperation,
            bodyLength: nestedBody.length
        });
        if (nestedOperation === 5) processDanmuPacket(nestedVersion, nestedBody, browserSocket, notify, roomId);
    });
}

function createLiveProxy(upgradeRequest, browserSocket, head) {
    const url = new URL(upgradeRequest.url, 'http://localhost');
    const roomId = Number(url.searchParams.get('room_id') || url.searchParams.get('roomid'));
    const uid = Number(url.searchParams.get('uid') || 0);
    const token = url.searchParams.get('token') || '';
    const suppliedHost = url.searchParams.get('host') || '';
    if (!roomId || !token) {
        browserSocket.close(1008, 'room_id and token are required');
        return;
    }

    const upstreamHost = suppliedHost.startsWith('wss://')
        ? suppliedHost
        : `wss://${suppliedHost || 'broadcastlv.chat.bilibili.com:443'}/sub`;
    const upstream = new WebSocket(upstreamHost, {
        headers: { Origin: 'https://live.bilibili.com', Referer: `https://live.bilibili.com/${roomId}` }
    });
    let heartbeat;
    let sequence = 1;

    const notify = (status, detail = {}) => {
        if (url.searchParams.get('debug')) console.log(`[BilibiliDanmu][proxy] ${status}`, detail);
        if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(JSON.stringify({ type: 'status', status, detail }));
    };

    let closing = false;
    const close = () => {
        if (closing) return;
        closing = true;
        clearInterval(heartbeat);
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
        if (browserSocket.readyState === WebSocket.OPEN) browserSocket.close();
    };

    upstream.on('open', () => {
        notify('upstream connected', { upstreamHost, roomId });
        upstream.send(packet(JSON.stringify({ roomid: roomId, uid, protover: 3, platform: 'web', type: 2, key: token }), 7));
    });
    upstream.on('message', data => {
        try {
            parseMessages(Buffer.from(data), ({ version, operation, body }) => {
                notify('upstream packet', { version, operation, bodyLength: body.length });
                if (operation === 8) {
                    clearInterval(heartbeat);
                    if (upstream.readyState === WebSocket.OPEN) upstream.send(packet('', 2, sequence++));
                    heartbeat = setInterval(() => {
                        if (upstream.readyState === WebSocket.OPEN) upstream.send(packet('', 2, sequence++));
                    }, 30000);
                    notify('upstream authenticated', { roomId, version });
                    return;
                }
                if (operation !== 5) return;
                notify('弹幕payload预览', {
                    version,
                    firstBytes: [...body.subarray(0, 16)],
                    compressed: true,
                    previewBase64: body.subarray(0, 48).toString('base64')
                });
                processDanmuPacket(version, body, browserSocket, notify, roomId);
            });
        } catch (error) {
            notify('decode failed', { message: error.message });
        }
    });
    upstream.on('error', error => {
        notify('upstream error', { message: error.message, upstreamHost });
        close();
    });
    upstream.on('close', (code, reason) => {
        notify('upstream closed', { code, reason: reason?.toString() || '', upstreamHost });
        close();
    });
    browserSocket.on('close', close);
    browserSocket.on('error', close);
}

function attachLiveProxy(server, basePath, biliPath) {
    const wssPath = `${basePath}${biliPath}/live/ws`;
    server.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname !== wssPath) return;
        const wss = new WebSocket.Server({ noServer: true });
        wss.handleUpgrade(request, socket, head, browserSocket => createLiveProxy(request, browserSocket, head));
    });
}

module.exports = {
    attachLiveProxy,
    packet,
    parseMessages,
    processDanmuPacket,
    normalizeDanmu,
    extractJsonObjects
};
