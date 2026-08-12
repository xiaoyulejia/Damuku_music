const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const WebSocket = require('ws');
const {
    packet,
    parseMessages,
    processDanmuPacket,
    normalizeDanmu,
    extractJsonObjects
} = require('../src/services/bili-live-ws');

test('keeps realtime WebSocket behind the explicit realtime=1 gate', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../src/public/services/danmuServers/bilibili-server.js'),
        'utf8'
    );
    const realtimeFlag = source.indexOf("params.get('realtime')");
    const historyDefault = source.indexOf('this.historyOnly = !realtime');
    const historyReturn = source.indexOf('this.startHistoryConsole();');
    const tokenRequest = source.indexOf("axios.get(`${this.baseUrl}/live/danmu-info`");
    const realtimeSocket = source.indexOf('this.webSocket = new WebSocket(this.socketUrl)');
    assert.ok(realtimeFlag >= 0 && historyDefault > realtimeFlag);
    assert.ok(historyReturn > historyDefault && tokenRequest > historyReturn);
    assert.ok(realtimeSocket > tokenRequest);
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

function newDanmuMessage(cmd = 'DANMU_MSG') {
    const first = [];
    first[15] = { user: { uid: 123, base: { name: '测试用户' } } };
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
