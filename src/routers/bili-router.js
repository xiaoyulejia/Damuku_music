const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const encrypt = require('../utils/encrypt');

// 创建axios实例，指向B站开放平台
const api = axios.create({
    baseURL: "https://live-open.biliapi.com"
});

const liveApi = axios.create({
    baseURL: "https://api.live.bilibili.com",
    headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'referer': 'https://live.bilibili.com/'
    }
});

// 鉴权加密处理headers
api.interceptors.request.use(config => {
    config.headers = encrypt.getEncodeHeader(config.data);
    return config;
});

// 创建Express路由器
const router = express.Router();
const sharedOrderStates = new Map();
const sharedOrderCommands = new Map();
let sharedOrderCommandSeq = 0;
const sharedSyncDir = path.join(__dirname, '../../logs/order-sync');
fs.mkdirSync(sharedSyncDir, { recursive: true });

function syncFilePath(prefix, roomId) {
    return path.join(sharedSyncDir, `${prefix}-${String(roomId).replace(/[^0-9a-z_-]/gi, '_')}.json`);
}

function readSyncFile(filePath, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function writeSyncFile(filePath, value) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value), 'utf8');
    fs.renameSync(tempPath, filePath);
}

const MIXIN_KEY_TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];

function wbiSign(params, mixinKey) {
    const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(signed).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(signed[key]).replace(/[!'()*]/g, ''))}`).join('&');
    return { ...signed, w_rid: crypto.createHash('md5').update(query + mixinKey).digest('hex') };
}

// OBS 浏览器源与外部浏览器之间的点歌状态同步
router.get('/live/sync-state', (req, res) => {
    const roomId = String(req.query.room_id || req.query.roomid || 'default');
    const state = readSyncFile(
        syncFilePath('state', roomId),
        sharedOrderStates.get(roomId) || null
    );
    if (state) sharedOrderStates.set(roomId, state);
    res.json({ code: 0, data: state });
});

router.post('/live/sync-state', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const state = req.body?.state;
    if (!state || typeof state !== 'object') {
        return res.status(400).json({ code: -1, message: 'state必须是对象' });
    }
    const filePath = syncFilePath('state', roomId);
    const current = readSyncFile(filePath, sharedOrderStates.get(roomId) || null);
    const incomingUpdatedAt = Number(state.updatedAt) || Date.now();
    const currentUpdatedAt = Number(current?.updatedAt) || 0;
    if (current && currentUpdatedAt > incomingUpdatedAt) {
        return res.json({ code: 0, data: current, ignored: true });
    }
    // 旧页面或尚未完成初始化的页面可能不会携带设置数据，不能因此清空
    // OBS 已经同步过来的历史记录和登录状态。
    const nextState = {
        ...state,
        settings: state.settings || current?.settings || null,
        updatedAt: incomingUpdatedAt
    };
    writeSyncFile(filePath, nextState);
    sharedOrderStates.set(roomId, nextState);
    res.json({ code: 0, data: nextState });
});

router.post('/live/sync-command', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const command = req.body?.command;
    if (!command || typeof command !== 'object') {
        return res.status(400).json({ code: -1, message: 'command必须是对象' });
    }
    const filePath = syncFilePath('commands', roomId);
    const list = readSyncFile(filePath, sharedOrderCommands.get(roomId) || []);
    const lastSequence = list.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0);
    const nextCommand = {
        ...command,
        sequence: Math.max(sharedOrderCommandSeq, lastSequence) + 1,
        createdAt: Date.now()
    };
    sharedOrderCommandSeq = nextCommand.sequence;
    const nextList = [...list, nextCommand].slice(-100);
    writeSyncFile(filePath, nextList);
    sharedOrderCommands.set(roomId, nextList);
    res.json({ code: 0 });
});

router.get('/live/sync-commands', (req, res) => {
    const roomId = String(req.query.room_id || req.query.roomid || 'default');
    const after = Number(req.query.after || 0);
    const since = Number(req.query.since || 0);
    const commands = readSyncFile(
        syncFilePath('commands', roomId),
        sharedOrderCommands.get(roomId) || []
    )
        .filter(command => command.sequence > after && command.createdAt >= since);
    res.json({ code: 0, data: commands });
});

async function getWbiMixinKey() {
    const { data } = await axios.get('https://api.bilibili.com/x/web-interface/nav');
    const wbi = data?.data?.wbi_img;
    if (!wbi?.img_url || !wbi?.sub_url) throw new Error('无法获取B站WBI密钥');
    const fileName = url => url.split('/').pop().split('.')[0];
    const origin = fileName(wbi.img_url) + fileName(wbi.sub_url);
    return MIXIN_KEY_TABLE.map(index => origin[index] || '').join('');
}

async function resolveRoomId(roomId) {
    try {
        const response = await liveApi.get('/xlive/web-room/v1/index/getH5InfoByRoom', {
            params: { room_id: roomId }
        });
        return Number(
            response.data?.data?.room_info?.room_id ||
            response.data?.data?.room_info?.roomid ||
            response.data?.data?.room_id ||
            roomId
        );
    } catch (_) {
        return roomId;
    }
}

// 普通直播间弹幕鉴权，不依赖B站开放平台许可
router.get('/live/danmu-info', async (req, res) => {
    const roomId = Number(req.query.room_id || req.query.roomid);
    if (!Number.isInteger(roomId) || roomId <= 0) return res.status(400).json({ code: -1, message: 'room_id必须是正整数' });
    try {
        const realRoomId = await resolveRoomId(roomId);
        const params = wbiSign({ id: realRoomId, web_location: 444.8 }, await getWbiMixinKey());
        const response = await liveApi.get('/xlive/web-room/v1/index/getDanmuInfo', { params });
        res.status(response.status).json({
            ...response.data,
            data: { ...response.data.data, _room_id: realRoomId }
        });
    } catch (error) {
        console.error('获取B站直播弹幕token失败:', error.response?.data || error.message);
        res.status(502).json({ code: -1, message: '获取B站直播弹幕token失败', detail: error.message });
    }
});

// 历史弹幕，仅用于调试房间号和字段解析，不参与实时点歌处理
router.get('/live/danmu-history', async (req, res) => {
    const roomId = Number(req.query.room_id || req.query.roomid);
    if (!Number.isInteger(roomId) || roomId <= 0) return res.status(400).json({ code: -1, message: 'room_id必须是正整数' });
    try {
        const realRoomId = await resolveRoomId(roomId);
        const response = await liveApi.get('/xlive/web-room/v1/dM/gethistory', {
            params: { roomid: realRoomId },
            headers: { referer: `https://live.bilibili.com/${realRoomId}` }
        });
        res.status(response.status).json({
            ...response.data,
            data: { ...response.data.data, _room_id: realRoomId }
        });
    } catch (error) {
        console.error('获取B站历史弹幕失败:', error.response?.data || error.message);
        res.status(502).json({ code: -1, message: '获取B站历史弹幕失败', detail: error.message });
    }
});

/**
 * 默认路由
 */
router.get("/", (req, res) => {
    res.send("B站开放平台API服务运行中");
});

/**
 * 互动玩法游戏启动接口
 */
router.post("/gameStart", async (req, res) => {
    await api.post("/v2/app/start", req.body)
        .then(({ data }) => {
            res.json(data);
            console.log(data);
        })
        .catch(err => {
            res.status(500).json(err);
        });
});

/**
 * 互动玩法游戏结束接口
 */
router.post("/gameEnd", async (req, res) => {
    await api.post("/v2/app/end", req.body)
        .then(({ data }) => {
            res.json(data);
        })
        .catch(err => {
            res.status(500).json(err);
        });
});

/**
 * 项目心跳接口
 */
router.post("/gameHeartBeat", async (req, res) => {
    await api.post("/v2/app/heartbeat", req.body)
        .then(({ data }) => {
            res.json(data);
        })
        .catch(err => {
            res.status(500).json(err);
        });
});

/**
 * 批量项目心跳接口
 */
router.post("/gameBatchHeartBeat", async (req, res) => {
    await api.post("/v2/app/batchHeartbeat", req.body)
        .then(({ data }) => {
            res.json(data);
        })
        .catch(err => {
            res.status(500).json(err);
        });
});

module.exports = router;
