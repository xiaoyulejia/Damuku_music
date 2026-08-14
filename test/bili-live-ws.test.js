const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const {
    LiveDanmuHub,
    RoomConnection,
    StatefulDanmuDecoder,
    packet,
    parseMessages,
    processDanmuPacket,
    normalizeDanmu,
    extractJsonObjects
} = require('../src/services/bili-live-ws');
const { BiliSession, CookieJar } = require('../src/services/bili-session');

test('keeps realtime WebSocket behind the explicit realtime=1 gate', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../src/public/services/danmuServers/bilibili-server.js'),
        'utf8'
    );
    const realtimeFlag = source.indexOf("params.get('realtime')");
    const historyDefault = source.indexOf('this.historyOnly = !realtime');
    const historyReturn = source.indexOf('this.startHistoryConsole();');
    const roomOnlyParams = source.indexOf("new URLSearchParams({ room_id: String(this.roomId) })");
    const realtimeSocket = source.indexOf('this.webSocket = new WebSocket(this.socketUrl)');
    assert.ok(realtimeFlag >= 0 && historyDefault > realtimeFlag);
    assert.ok(historyReturn > historyDefault && roomOnlyParams > historyReturn);
    assert.ok(realtimeSocket > roomOnlyParams);
    assert.doesNotMatch(source, /proxyParams[^\n]*token/);
    assert.doesNotMatch(source, /proxyParams[^\n]*host/);
});

test('prints an explicit WebSocket realtime danmu log only in debug mode', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../src/public/services/danmuServers/bilibili-server.js'),
        'utf8'
    );
    const danmuBranch = source.indexOf("message.type === 'danmu'");
    const debugGuard = source.indexOf('if (this.debug)', danmuBranch);
    const realtimeLog = source.indexOf('[BilibiliDanmu][WebSocket实时弹幕]', debugGuard);
    const callback = source.indexOf('this.danmuMessage(message.data)', realtimeLog);
    assert.ok(danmuBranch >= 0 && debugGuard > danmuBranch);
    assert.ok(realtimeLog > debugGuard && callback > realtimeLog);
});

test('allows realtime debug observation on mirror pages without processing commands', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '../src/public/main.js'), 'utf8');
    const configSource = fs.readFileSync(
        path.join(__dirname, '../src/public/components/danmu-configer.js'),
        'utf8'
    );
    assert.match(mainSource, /realtimeDebugObserver/);
    assert.match(mainSource, /startDanmu\(\{ processCommands: false \}\)/);
    assert.match(configSource, /processCommands\s*\?\s*this\.identifyDanmuCommand\.bind\(this\)\s*:\s*null/);
});

function protocolPacket(body, operation = 5, version = 1, sequence = 1) {
    const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const result = Buffer.alloc(16 + content.length);
    result.writeUInt32BE(result.length, 0);
    result.writeUInt16BE(16, 4);
    result.writeUInt16BE(version, 6);
    result.writeUInt32BE(operation, 8);
    result.writeUInt32BE(sequence, 12);
    content.copy(result, 16);
    return result;
}

function newDanmuMessage(cmd = 'DANMU_MSG', messageId = '') {
    const first = [];
    first[15] = {
        user: { uid: 123, base: { name: '测试用户' } },
        extra: messageId ? JSON.stringify({ id_str: messageId }) : undefined
    };
    return { cmd, info: [first, '点歌 测试歌曲', [456, '旧版用户']] };
}

function fakeBrowserSocket() {
    const sent = [];
    return {
        readyState: WebSocket.OPEN,
        send(value) { sent.push(JSON.parse(value)); },
        sent
    };
}

test('encodes the 16-byte Bilibili auth packet header', () => {
    const result = packet('{"roomid":1}', 7, 9);
    assert.strictEqual(result.readUInt32BE(0), result.length);
    assert.strictEqual(result.readUInt16BE(4), 16);
    assert.strictEqual(result.readUInt16BE(6), 1);
    assert.strictEqual(result.readUInt32BE(8), 7);
    assert.strictEqual(result.readUInt32BE(12), 9);
});

test('parses multiple binary packets and returns an incomplete remainder', () => {
    const first = protocolPacket('{"cmd":"ONE"}');
    const second = protocolPacket('{"cmd":"TWO"}');
    const partial = protocolPacket('{"cmd":"THREE"}').subarray(0, 20);
    const seen = [];
    const remainder = parseMessages(Buffer.concat([first, second, partial]), item => seen.push(item.body.toString()));
    assert.deepStrictEqual(seen, ['{"cmd":"ONE"}', '{"cmd":"TWO"}']);
    assert.deepStrictEqual(remainder, partial);
});

test('stateful decoder preserves a protocol packet split across WebSocket messages', () => {
    const complete = protocolPacket('{"cmd":"SPLIT"}');
    const seen = [];
    const decoder = new StatefulDanmuDecoder(item => seen.push(item.body.toString()));
    assert.strictEqual(decoder.push(complete.subarray(0, 11)), 11);
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(decoder.push(complete.subarray(11, 24)), 24);
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(decoder.push(complete.subarray(24)), 0);
    assert.deepStrictEqual(seen, ['{"cmd":"SPLIT"}']);
});

test('rejects invalid packet lengths', () => {
    const invalid = Buffer.alloc(16);
    invalid.writeUInt32BE(8, 0);
    invalid.writeUInt16BE(16, 4);
    assert.throws(() => parseMessages(invalid, () => {}), /invalid danmu packet/);
});

test('normalizes new and legacy DANMU_MSG layouts including command suffixes', () => {
    const modern = normalizeDanmu(newDanmuMessage('DANMU_MSG:4:0:2:2:2:0'), 999);
    assert.deepStrictEqual(
        { uid: modern.uid, uname: modern.uname, danmu: modern.danmu, roomId: modern.roomId },
        { uid: 123, uname: '测试用户', danmu: '点歌 测试歌曲', roomId: 999 }
    );
    const legacy = normalizeDanmu({ cmd: 'DANMU_MSG', info: [[], '切歌', [456, '旧版用户']] }, 999);
    assert.strictEqual(legacy.uid, 456);
    assert.strictEqual(legacy.uname, '旧版用户');
    assert.strictEqual(normalizeDanmu({ cmd: 'SEND_GIFT' }, 999), null);
    const anonymous = newDanmuMessage();
    anonymous.info[0][15].user.uid = 0;
    anonymous.info[0][15].extra = JSON.stringify({ user_hash: '2570797531' });
    anonymous.info[2][0] = 0;
    assert.strictEqual(normalizeDanmu(anonymous, 999).uid, -2570797531);
});

test('extracts adjacent JSON objects without breaking braces inside strings', () => {
    assert.deepStrictEqual(
        extractJsonObjects('{"text":"a}{b"}{"text":"c"}'),
        ['{"text":"a}{b"}', '{"text":"c"}']
    );
});

for (const [name, version, compress] of [
    ['zlib', 2, zlib.deflateSync],
    ['brotli', 3, zlib.brotliCompressSync]
]) {
    test(`decodes ${name} nested DANMU_MSG packets like PiliPlus`, () => {
        const message = Buffer.from(JSON.stringify(newDanmuMessage()));
        const nested = protocolPacket(message, 5, 1);
        const browser = fakeBrowserSocket();
        processDanmuPacket(version, compress(nested), browser, () => {}, 999);
        const output = browser.sent.find(item => item.type === 'danmu');
        assert.ok(output);
        assert.strictEqual(output.data.uid, 123);
        assert.strictEqual(output.data.uname, '测试用户');
        assert.strictEqual(output.data.danmu, '点歌 测试歌曲');
        assert.strictEqual(output.data.roomId, 999);
    });
}

test('anonymous BiliSession reuses buvid and Set-Cookie while resolving room and token', async () => {
    const calls = [];
    const http = {
        async request(config) {
            calls.push(config);
            if (config.url.includes('/x/frontend/finger/spi')) {
                return {
                    data: { code: 0, data: { b_3: 'SERVER-BUVID3', b_4: 'SERVER-BUVID4' } },
                    headers: {}
                };
            }
            if (config.url.includes('/x/web-interface/nav')) {
                return {
                    data: { data: { wbi_img: {
                        img_url: `https://i.example/${'a'.repeat(32)}.png`,
                        sub_url: `https://i.example/${'b'.repeat(32)}.png`
                    } } },
                    headers: { 'set-cookie': ['sid=test-session; Domain=.bilibili.com; Path=/'] }
                };
            }
            if (config.url.includes('getH5InfoByRoom')) {
                return { data: { code: 0, data: { room_info: { room_id: 999 } } }, headers: {} };
            }
            if (config.url.includes('getDanmuInfo')) {
                return { data: { code: 0, data: {
                    token: 'secret-token',
                    host_list: [{ host: 'broadcast.example', wss_port: 443 }]
                } }, headers: {} };
            }
            throw new Error(`unexpected URL ${config.url}`);
        }
    };
    const session = new BiliSession({ http, cacheFile: null });
    const info = await session.getDanmuInfo(1);
    assert.strictEqual(info.roomId, 999);
    assert.strictEqual(info.token, 'secret-token');
    assert.deepStrictEqual(info.hosts, ['wss://broadcast.example:443/sub']);
    assert.strictEqual(info.uid, 0);
    assert.ok(calls.every(call => call.headers.cookie.includes('buvid3=')));
    assert.strictEqual(session.getBuvid3(), 'SERVER-BUVID3');
    const tokenCall = calls.find(call => call.url.includes('getDanmuInfo'));
    assert.ok(tokenCall.headers.cookie.includes('sid=test-session'));
    assert.ok(tokenCall.headers.cookie.includes('buvid4=SERVER-BUVID4'));
});

test('BiliSession sends the official HTTP message ACK with the same cookie session', async () => {
    const calls = [];
    const session = new BiliSession({
        cacheFile: null,
        http: {
            async request(config) {
                calls.push(config);
                return { data: { code: 0 }, headers: {} };
            }
        }
    });
    await session.acknowledgeMessages(42);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].url, /\/xlive\/open-interface\/v1\/dm\/message_ack$/);
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(calls[0].data, 'terminal=0&sequence=42');
    assert.match(calls[0].headers.cookie, /buvid3=/);
});

test('CookieJar applies domain, path and secure rules', () => {
    const jar = new CookieJar();
    jar.set('shared', '1', { domain: '.bilibili.com' });
    jar.set('liveOnly', '2', { domain: 'api.live.bilibili.com', path: '/xlive', secure: true });
    assert.match(jar.headerFor('https://api.live.bilibili.com/xlive/test'), /shared=1/);
    assert.match(jar.headerFor('https://api.live.bilibili.com/xlive/test'), /liveOnly=2/);
    assert.doesNotMatch(jar.headerFor('https://api.bilibili.com/x/web-interface/nav'), /liveOnly=2/);
});

test('LiveDanmuHub shares one RoomConnection and one upstream per real room', async () => {
    const session = {
        calls: 0,
        async getDanmuInfo() {
            this.calls++;
            return { roomId: 999, uid: 0, token: 'token', hosts: ['wss://one.example/sub'] };
        },
        diagnostics() { return { mode: 'anonymous', uid: 0, hasBuvid3: true }; }
    };
    class FakeUpstream extends EventEmitter {
        static instances = [];
        constructor(url) {
            super();
            this.url = url;
            this.readyState = WebSocket.CONNECTING;
            FakeUpstream.instances.push(this);
        }
        send() {}
        close() { this.readyState = WebSocket.CLOSED; }
    }
    class FakeBrowser extends EventEmitter {
        constructor() {
            super();
            this.readyState = WebSocket.OPEN;
            this.sent = [];
        }
        send(value) { this.sent.push(JSON.parse(value)); }
    }
    const hub = new LiveDanmuHub({ session, WebSocketImpl: FakeUpstream });
    const first = new FakeBrowser();
    const second = new FakeBrowser();
    await hub.subscribe(1, first);
    await hub.subscribe(1, second);
    assert.strictEqual(session.calls, 1);
    assert.strictEqual(hub.rooms.size, 1);
    assert.strictEqual(FakeUpstream.instances.length, 1);
    assert.strictEqual([...hub.rooms.values()][0].subscribers.size, 2);
    hub.dispose();
});

test('RoomConnection sends the complete current web-player auth body', async () => {
    class FakeUpstream extends EventEmitter {
        constructor() {
            super();
            this.readyState = WebSocket.CONNECTING;
            this.sent = [];
        }
        send(value) { this.sent.push(Buffer.from(value)); }
        close() { this.readyState = WebSocket.CLOSED; }
    }
    const session = {
        getBuvid3() { return 'TEST-BUVID'; },
        diagnostics() { return { mode: 'anonymous', uid: 0, hasBuvid3: true }; }
    };
    const room = new RoomConnection(
        { roomId: 498388, uid: 0, token: 'token', hosts: ['wss://unused.example/sub'] },
        { session, WebSocketImpl: FakeUpstream }
    );
    await room.connect();
    room.upstream.readyState = WebSocket.OPEN;
    room.upstream.emit('open');
    const authPacket = room.upstream.sent[0];
    const auth = JSON.parse(authPacket.subarray(16).toString('utf8'));
    assert.strictEqual(authPacket.readUInt32BE(8), 7);
    assert.deepStrictEqual(
        {
            roomid: auth.roomid,
            uid: auth.uid,
            protover: auth.protover,
            buvid: auth.buvid,
            support_ack: auth.support_ack,
            scene: auth.scene,
            platform: auth.platform,
            type: auth.type,
            key: auth.key
        },
        {
            roomid: 498388,
            uid: 0,
            protover: 3,
            buvid: 'TEST-BUVID',
            support_ack: true,
            scene: 'room',
            platform: 'web',
            type: 2,
            key: 'token'
        }
    );
    assert.match(auth.queue_uuid, /^[a-z0-9]{8}$/);
    room.dispose();
});

test('RoomConnection acknowledges protocol sequences and per-message socket ACK requests', async () => {
    const acknowledged = [];
    const session = {
        async acknowledgeMessages(sequence) { acknowledged.push(sequence); },
        diagnostics() { return { mode: 'anonymous', uid: 0, hasBuvid3: true }; }
    };
    const room = new RoomConnection(
        { roomId: 999, uid: 0, token: 'token', hosts: ['wss://unused.example/sub'] },
        { session }
    );
    const sent = [];
    room.upstream = { readyState: WebSocket.OPEN, send(value) { sent.push(Buffer.from(value)); } };
    room.handleProtocolPacket({
        operation: 5,
        version: 1,
        sequence: 73,
        body: Buffer.from(JSON.stringify({
            cmd: 'INTERACT_WORD_V2',
            msg_id: 'message-1',
            p_is_ack: true,
            p_msg_type: 2
        }))
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(acknowledged, [73]);
    assert.strictEqual(room.metrics.lastAckedSequence, 73);
    assert.strictEqual(room.metrics.httpAckSuccessCount, 1);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].readUInt32BE(8), 24);
    assert.deepStrictEqual(JSON.parse(sent[0].subarray(16).toString()), {
        msg_id: 'message-1',
        cmd: 'INTERACT_WORD_V2',
        p_msg_type: 2
    });
    room.dispose();
});

test('RoomConnection deduplicates realtime repeats and history recovery by message id', async () => {
    const session = {
        diagnostics() { return { mode: 'anonymous', uid: 0, hasBuvid3: true }; },
        async getHistory() {
            return {
                roomId: 999,
                items: [
                    { id_str: 'before-disconnect', uid: 111, uname: '旧消息', text: '点歌 不应补偿', timeline: '2026-08-13 11:00:00' },
                    { id_str: 'same-id', uid: 123, uname: '测试用户', text: '点歌 测试歌曲', timeline: '2026-08-13 12:00:00' },
                    { id_str: 'recovered-id', uid: 456, uname: '补偿用户', text: '点歌 补偿歌曲', timeline: '2026-08-13 12:00:01' }
                ]
            };
        }
    };
    const room = new RoomConnection(
        { roomId: 999, uid: 0, token: 'token', hosts: ['wss://unused.example/sub'] },
        { session }
    );
    const browser = fakeBrowserSocket();
    room.subscribers.set(browser, { debug: false });
    room.connectionId = 'dedupe-test';
    room.disconnectedAt = Date.parse('2026-08-13T11:59:59+08:00');
    const message = newDanmuMessage('DANMU_MSG:4:0:2', 'same-id');
    room.handleMessage(message);
    room.handleMessage(message);
    await room.recoverHistory();
    const events = browser.sent.filter(item => item.type === 'danmu');
    assert.deepStrictEqual(events.map(item => item.data.messageId), ['same-id', 'recovered-id']);
    assert.deepStrictEqual(events.map(item => item.data.source), ['websocket', 'history-recovery']);
    room.dispose();
});
