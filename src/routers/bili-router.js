const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const encrypt = require('../utils/encrypt');
const { LocalStore, mergeSettings } = require('../services/local-store');

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
// 网易云 Cookie 只在当前 Node 进程内存中短暂转发，不写入状态文件或日志。
const sharedRuntimeCredentials = new Map();
const localStore = new LocalStore(path.resolve(__dirname, '../..'));
let sharedOrderCommandSeq = 0;
// OBS 最小化后，内置 Chromium 可能把页面定时器延迟数秒甚至更久。
// 5 秒租约会把仍在播放的 OBS 误判为离线，导致播放端被重新接管。
const SYNC_PUBLISHER_LEASE_MS = 60 * 1000;
const sharedSyncDir = localStore.cacheDir;
fs.mkdirSync(sharedSyncDir, { recursive: true });
const MAX_COMMAND_LOG_ENTRIES = 1000;
const MAX_COMMAND_LOG_BYTES = 512 * 1024;
const COMMAND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUEUE_REORDER_ITEMS = 5000;

function syncFilePath(prefix, roomId) {
    return path.join(sharedSyncDir, `${prefix}-${String(roomId).replace(/[^0-9a-z_-]/gi, '_')}.json`);
}

function commandLogPath(roomId) {
    return path.join(sharedSyncDir, `commands-${String(roomId).replace(/[^0-9a-z_-]/gi, '_')}.jsonl`);
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

function readCommandLog(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line))
            .filter(item => item && typeof item === 'object');
    } catch (_) {
        return [];
    }
}

function compactCommandLog(filePath, commands) {
    const cutoff = Date.now() - COMMAND_RETENTION_MS;
    const retained = commands
        .filter(item => Number(item.createdAt) >= cutoff)
        .slice(-MAX_COMMAND_LOG_ENTRIES);
    const content = retained.map(item => JSON.stringify(item)).join('\n');
    fs.writeFileSync(filePath, content ? `${content}\n` : '', 'utf8');
    return retained;
}

function appendCommandLog(filePath, command, existing) {
    fs.appendFileSync(filePath, `${JSON.stringify(command)}\n`, 'utf8');
    const next = [...existing, command];
    let retained = next;
    try {
        if (fs.statSync(filePath).size > MAX_COMMAND_LOG_BYTES || next.length > MAX_COMMAND_LOG_ENTRIES) {
            retained = compactCommandLog(filePath, next);
        }
    } catch (_) { /* the command has already been appended; next request can recover */ }
    return retained;
}

function defaultRoomState() {
    return {
        queue: [],
        currentSong: null,
        currentRequester: '',
        status: '等待播放',
        volume: 50,
        audioUnlockRequired: false,
        playback: {
            songKey: '',
            positionMs: 0,
            durationMs: 0,
            paused: true,
            seeking: false,
            readyState: 0,
            sampledAt: 0
        },
        songListId: '',
        idleSongList: [],
        idleIndex: -1,
        idleSongCount: 0,
        playbackAction: null,
        playbackActionId: '',
        settings: { order: mergeSettings().order, login: null },
        commandResult: null,
        lastSongListRequestId: '',
        publisherId: null,
        publisherStartedAt: 0,
        publisherHeartbeatAt: 0,
        updatedAt: 0,
        stateRevision: 0,
        queueRevision: 0
    };
}

function createOrderId() {
    return `ord-${Date.now()}-${crypto.randomBytes(6).toString('base64url')}`;
}

function normalizeSong(song) {
    if (!song || typeof song !== 'object' || song.sid == null) return null;
    return {
        platform: String(song.platform || 'wy'),
        sid: String(song.sid),
        sname: String(song.sname || song.name || '').slice(0, 300),
        sartist: String(song.sartist || song.artist || '').slice(0, 300),
        duration: Number(song.duration) || 0
    };
}

function songKey(song) {
    if (!song?.sid) return '';
    return `${song.platform || 'wy'}:${song.sid}`;
}

function finiteClamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function normalizePlayback(playback, currentSong) {
    const expectedKey = songKey(currentSong);
    const durationMs = finiteClamp(playback?.durationMs, 0, 24 * 60 * 60 * 1000);
    const positionMs = finiteClamp(playback?.positionMs, 0, durationMs || 24 * 60 * 60 * 1000);
    const sameSong = playback?.songKey === expectedKey && Boolean(expectedKey);
    return {
        songKey: sameSong ? expectedKey : '',
        positionMs: sameSong ? positionMs : 0,
        durationMs: sameSong ? durationMs : 0,
        paused: Boolean(playback?.paused),
        seeking: Boolean(playback?.seeking),
        readyState: finiteClamp(playback?.readyState, 0, 4),
        sampledAt: finiteClamp(playback?.sampledAt, 0, Date.now() + 60_000)
    };
}

function normalizeOrder(order, fallbackUid = 0, fallbackUname = '空闲歌单') {
    if (!order || typeof order !== 'object') return null;
    const song = normalizeSong(order.song || order);
    if (!song) return null;
    return {
        orderId: String(order.orderId || '').trim() || createOrderId(),
        uid: Number(order.uid) || fallbackUid,
        uname: String(order.uname || fallbackUname),
        song,
        requestedAt: Number(order.requestedAt) || Date.now(),
        source: ['danmu', 'idle', 'manual'].includes(order.source)
            ? order.source
            : (Number(order.uid) === 0 ? 'idle' : 'danmu')
    };
}

function normalizeIdleSongList(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 5000).map(item => normalizeOrder(item)).filter(Boolean);
}

function normalizeRoomState(input = {}) {
    const defaults = defaultRoomState();
    const queue = Array.isArray(input.queue)
        ? input.queue.map(item => normalizeOrder(item, 0, '')).filter(Boolean)
        : [];
    const idleSongList = normalizeIdleSongList(input.idleSongList);
    const currentSong = normalizeSong(input.currentSong) || queue[0]?.song || null;
    return {
        ...defaults,
        ...input,
        queue,
        currentSong,
        playback: normalizePlayback(input.playback, currentSong),
        currentRequester: String(input.currentRequester || queue[0]?.uname || ''),
        status: String(input.status || (currentSong ? '等待播放' : '等待点歌')),
        volume: Math.max(0, Math.min(100, input.volume == null ? defaults.volume : Number(input.volume) || 0)),
        songListId: String(input.songListId || ''),
        idleSongList,
        idleIndex: idleSongList.length
            ? Math.max(-1, Math.min(
                idleSongList.length - 1,
                input.idleIndex == null ? -1 : Number(input.idleIndex)
            ))
            : -1,
        idleSongCount: idleSongList.length,
        stateRevision: Math.max(0, Number(input.stateRevision) || 0),
        queueRevision: Math.max(0, Number(input.queueRevision) || 0),
        settings: {
            order: mergeSettings({ order: input.settings?.order || {} }).order,
            login: input.settings?.login && typeof input.settings.login === 'object'
                ? {
                    platform: String(input.settings.login.platform || ''),
                    songListId: String(input.settings.login.songListId || ''),
                    songListHistory: Array.isArray(input.settings.login.songListHistory)
                        ? input.settings.login.songListHistory.slice(-100)
                        : [],
                    neteaseLoginStatus: input.settings.login.neteaseLoginStatus || null
                }
                : null
        },
        commandResult: input.commandResult || null,
        lastSongListRequestId: String(input.lastSongListRequestId || '')
    };
}

function readRoomState(roomId) {
    const stored = readSyncFile(
        syncFilePath('state', roomId),
        sharedOrderStates.get(roomId) || null
    );
    const storedSettings = localStore.getSettings(roomId);
    const state = stored || {};
    const normalized = normalizeRoomState({
        ...state,
        settings: {
            ...(state.settings || {}),
            order: state.settings?.order || storedSettings.order,
            login: state.settings?.login || storedSettings.login
        }
    });
    // 老状态没有 orderId 时，第一次读取即完成迁移并保持原 revision，
    // 后续所有插入/排序操作都可以只依赖稳定 ID。
    const needsMigration = Boolean(stored) && (
        normalized.queue.some((item, index) => !stored.queue?.[index]?.orderId) ||
        normalized.idleSongList.some((item, index) => !stored.idleSongList?.[index]?.orderId)
    );
    if (needsMigration) {
        normalized.updatedAt = Date.now();
        writeSyncFile(syncFilePath('state', roomId), normalized);
    }
    sharedOrderStates.set(roomId, normalized);
    return normalized;
}

function persistRoomState(roomId, state, { bumpRevision = true, bumpQueueRevision = false } = {}) {
    const nextState = normalizeRoomState(state);
    nextState.stateRevision = bumpRevision
        ? (Number(nextState.stateRevision) || 0) + 1
        : Number(nextState.stateRevision) || 0;
    nextState.queueRevision = bumpQueueRevision
        ? (Number(nextState.queueRevision) || 0) + 1
        : Number(nextState.queueRevision) || 0;
    nextState.updatedAt = Date.now();
    writeSyncFile(syncFilePath('state', roomId), nextState);
    sharedOrderStates.set(roomId, nextState);
    return nextState;
}

function appendNextIdleSong(state) {
    if (!state.idleSongList.length) return null;
    state.idleIndex = (state.idleIndex + 1) % state.idleSongList.length;
    const order = normalizeOrder({
        ...state.idleSongList[state.idleIndex],
        orderId: createOrderId(),
        source: 'idle',
        requestedAt: Date.now()
    });
    if (!order) return null;
    state.queue.push(order);
    return order;
}

function shuffleOnce(list) {
    const result = list.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function currentOrderId(state) {
    return String(state.queue[0]?.orderId || '');
}

function queueConflict(state, value, { requireQueueRevision = false } = {}) {
    if (!value || typeof value !== 'object') {
        return { accepted: false, reason: '队列操作参数无效', httpStatus: 400 };
    }
    if (value.expectedRevision != null &&
        Number(value.expectedRevision) !== Number(state.stateRevision)) {
        return { accepted: false, reason: 'state-revision-conflict', httpStatus: 409 };
    }
    if (requireQueueRevision && (value.expectedQueueRevision == null ||
        Number(value.expectedQueueRevision) !== Number(state.queueRevision))) {
        return { accepted: false, reason: 'queue-revision-conflict', httpStatus: 409 };
    }
    if (value.expectedQueueRevision != null &&
        Number(value.expectedQueueRevision) !== Number(state.queueRevision)) {
        return { accepted: false, reason: 'queue-revision-conflict', httpStatus: 409 };
    }
    if (value.expectedCurrentOrderId != null &&
        String(value.expectedCurrentOrderId) !== currentOrderId(state)) {
        return { accepted: false, reason: 'current-song-changed', httpStatus: 409 };
    }
    return null;
}

function applyRoomCommand(roomId, command) {
    const state = readRoomState(roomId);
    const value = command.value;
    let result = { accepted: true, command: command.command };
    let queueChanged = false;
    switch (command.command) {
        case 'loadSongList': {
            const payload = value && typeof value === 'object' ? value : { listId: value };
            if (Array.isArray(payload.songList) && payload.songList.length > 5000) {
                result = { accepted: false, command: command.command, reason: '歌单最多支持 5000 首歌曲', requestId: String(payload.requestId || command.requestId || '') };
                state.commandResult = result;
                return { state, result };
            }
            const list = normalizeIdleSongList(payload.songList);
            const listId = String(payload.listId || '').trim();
            const requestId = String(payload.requestId || command.requestId || '');
            const requestOrder = Number(requestId.split('-')[0]) || 0;
            const previousOrder = Number(String(state.lastSongListRequestId || '').split('-')[0]) || 0;
            if (requestOrder && previousOrder && requestOrder < previousOrder) {
                result = { accepted: false, command: command.command, reason: '请求已过期', requestId };
                state.commandResult = result;
                return { state, result };
            }
            if (!listId || !list.length) {
                result = { accepted: false, command: command.command, reason: !listId ? '歌单ID不能为空' : '歌单为空或格式无效', requestId };
                state.commandResult = result;
                return { state, result };
            }

            // 原子切换：先保留用户点歌，再移除所有旧的空闲歌单歌曲。
            const current = state.queue[0] || null;
            const userQueue = state.queue.filter(order => Number(order.uid) !== 0);
            state.idleSongList = shuffleOnce(list);
            state.idleIndex = -1;
            state.songListId = listId;
            state.lastSongListRequestId = requestId;
            state.settings.login = {
                ...(state.settings.login || {}),
                platform: String(payload.platform || state.settings.login?.platform || list[0]?.song?.platform || ''),
                songListId: listId
            };
            localStore.updateSettings(roomId, { login: state.settings.login }, null);
            state.queue = current && Number(current.uid) !== 0 ? userQueue : [];
            if (!current || Number(current.uid) === 0) {
                appendNextIdleSong(state);
                state.queue.push(...userQueue);
            }
            state.currentSong = state.queue[0]?.song || null;
            state.currentRequester = state.queue[0]?.uname || '';
            state.status = state.currentSong ? '等待播放' : '等待点歌';
            queueChanged = true;
            result = {
                accepted: true,
                command: command.command,
                switched: true,
                startsImmediately: Number(current?.uid || 0) === 0 || !current,
                songListId: state.songListId,
                requestId
            };
            break;
        }
        case 'addOrder': {
            const order = normalizeOrder(value, 0, '');
            if (!order || order.uid === 0) {
                result = { accepted: false, command: command.command, reason: '点歌数据无效' };
                break;
            }
            const orderSettings = state.settings.order || mergeSettings().order;
            const userOrders = state.queue.filter(item => Number(item.uid) === Number(order.uid));
            const activeOrders = state.queue.filter(item => Number(item.uid) !== 0);
            if (userOrders.length >= orderSettings.userMaxOrder) {
                result = { accepted: false, command: command.command, reason: '该用户点歌数已达上限' };
                break;
            }
            if (activeOrders.length >= orderSettings.globalMaxOrder) {
                result = { accepted: false, command: command.command, reason: '点歌队列已达上限' };
                break;
            }
            if (orderSettings.orderMaxDuration > 0 && order.song.duration > orderSettings.orderMaxDuration) {
                result = { accepted: false, command: command.command, reason: '歌曲超过时长限制' };
                break;
            }
            if (orderSettings.userBlackList.some(item => String(item.uid) === String(order.uid)) ||
                orderSettings.songBlackList.some(item => String(item.sid) === String(order.song.sid))) {
                result = { accepted: false, command: command.command, reason: '用户或歌曲在黑名单中' };
                break;
            }
            if (state.queue.some(item => item.song.sid === order.song.sid)) {
                result = { accepted: false, command: command.command, reason: '歌曲已在点歌列表中' };
                break;
            }
            // 客户端不能决定一次点歌的身份；服务端为每次新入队生成新 ID。
            order.orderId = createOrderId();
            order.requestedAt = Date.now();
            order.source = 'danmu';
            state.queue.push(order);
            if (!state.currentSong) {
                state.currentSong = order.song;
                state.currentRequester = order.uname;
            }
            queueChanged = true;
            break;
        }
        case 'next':
            if (state.queue.length) state.queue.shift();
            if (!state.queue.length) appendNextIdleSong(state);
            state.currentSong = state.queue[0]?.song || null;
            state.currentRequester = state.queue[0]?.uname || '';
            state.status = state.currentSong ? '等待播放' : '等待点歌';
            queueChanged = true;
            break;
        case 'promoteNext': {
            const conflict = queueConflict(state, value);
            if (conflict) {
                result = { accepted: false, command: command.command, ...conflict };
                break;
            }
            const orderId = String(value?.orderId || '').trim();
            if (!orderId || orderId.length > 200) {
                result = { accepted: false, command: command.command, reason: 'orderId无效', httpStatus: 400 };
                break;
            }
            const targetIndex = state.queue.findIndex(item => item.orderId === orderId);
            if (targetIndex < 0) {
                result = { accepted: false, command: command.command, reason: 'order-not-found', httpStatus: 409 };
                break;
            }
            if (Number(state.queue[targetIndex].uid) === 0) {
                result = { accepted: false, command: command.command, reason: 'idle-order-not-promotable', httpStatus: 400 };
                break;
            }
            const hasCurrent = Boolean(state.currentSong && state.queue[0]);
            const nextIndex = hasCurrent ? 1 : 0;
            if (targetIndex === 0 && hasCurrent) {
                result = { accepted: false, command: command.command, reason: 'already-playing', httpStatus: 409 };
                break;
            }
            if (targetIndex === nextIndex) {
                result = { accepted: true, command: command.command, moved: false, reason: 'already-next', orderId };
                break;
            }
            const [target] = state.queue.splice(targetIndex, 1);
            state.queue.splice(nextIndex, 0, target);
            result = {
                accepted: true,
                command: command.command,
                moved: true,
                orderId,
                fromIndex: targetIndex,
                toIndex: nextIndex
            };
            queueChanged = true;
            break;
        }
        case 'reorderQueue': {
            const conflict = queueConflict(state, value, { requireQueueRevision: true });
            if (conflict) {
                result = { accepted: false, command: command.command, ...conflict };
                break;
            }
            const pendingOrderIds = value?.pendingOrderIds;
            if (!Array.isArray(pendingOrderIds) || pendingOrderIds.length > MAX_QUEUE_REORDER_ITEMS) {
                result = { accepted: false, command: command.command, reason: 'pendingOrderIds无效', httpStatus: 400 };
                break;
            }
            const current = state.queue[0] || null;
            const pending = current ? state.queue.slice(1) : state.queue.slice();
            if (pending.some(item => Number(item.uid) === 0)) {
                result = { accepted: false, command: command.command, reason: 'idle-order-not-reorderable', httpStatus: 400 };
                break;
            }
            const ids = pendingOrderIds.map(item => String(item || '').trim());
            const uniqueIds = new Set(ids);
            const existingIds = new Set(pending.map(item => item.orderId));
            if (ids.some(id => !id || id.length > 200) || uniqueIds.size !== ids.length ||
                ids.length !== pending.length || uniqueIds.size !== existingIds.size ||
                ids.some(id => !existingIds.has(id))) {
                result = { accepted: false, command: command.command, reason: '队列歌曲集合已变化', httpStatus: 409 };
                break;
            }
            const orderedPending = ids.map(id => pending.find(item => item.orderId === id));
            const moved = orderedPending.some((item, index) => item.orderId !== pending[index]?.orderId);
            if (!moved) {
                result = { accepted: true, command: command.command, moved: false, reason: 'already-ordered' };
                break;
            }
            state.queue = current ? [current, ...orderedPending] : orderedPending;
            result = { accepted: true, command: command.command, moved: true };
            queueChanged = true;
            break;
        }
        case 'removeOrder': {
            const conflict = queueConflict(state, value, { requireQueueRevision: true });
            if (conflict) {
                result = { accepted: false, command: command.command, ...conflict };
                break;
            }
            const orderId = String(value?.orderId || '').trim();
            if (!orderId || orderId.length > 200) {
                result = { accepted: false, command: command.command, reason: 'orderId无效', httpStatus: 400 };
                break;
            }
            const targetIndex = state.queue.findIndex(item => String(item.orderId) === orderId);
            if (targetIndex < 0) {
                result = { accepted: false, command: command.command, reason: 'order-not-found', httpStatus: 409 };
                break;
            }
            if (targetIndex === 0 || String(state.queue[targetIndex]?.orderId) === currentOrderId(state)) {
                result = { accepted: false, command: command.command, reason: 'current-song-not-removable', httpStatus: 400 };
                break;
            }
            const [removed] = state.queue.splice(targetIndex, 1);
            result = {
                accepted: true,
                command: command.command,
                removed: true,
                orderId,
                songName: removed?.song?.sname || ''
            };
            queueChanged = true;
            break;
        }
        case 'play':
            if (!state.currentSong) {
                if (!state.queue.length) {
                    const queueLength = state.queue.length;
                    appendNextIdleSong(state);
                    queueChanged = state.queue.length !== queueLength;
                }
                state.currentSong = state.queue[0]?.song || null;
                state.currentRequester = state.queue[0]?.uname || '';
            }
            break;
        case 'volume':
            state.volume = Math.max(0, Math.min(100, Number(value) || 0));
            break;
        case 'seek': {
            if (!state.currentSong) {
                result = { accepted: false, command: command.command, reason: 'no-current-song', httpStatus: 409 };
                break;
            }
            const expectedSongKey = String(value?.expectedSongKey || '');
            if (expectedSongKey !== songKey(state.currentSong)) {
                result = { accepted: false, command: command.command, reason: 'song-changed', httpStatus: 409 };
                break;
            }
            const rawPosition = Number(value?.positionMs);
            if (!Number.isFinite(rawPosition) || rawPosition < 0) {
                result = { accepted: false, command: command.command, reason: 'position-invalid', httpStatus: 400 };
                break;
            }
            const durationMs = Number(state.playback?.durationMs) || Number(state.currentSong.duration || 0) * 1000;
            const positionMs = Math.max(0, Math.min(durationMs > 0 ? durationMs : rawPosition, rawPosition));
            state.playback = {
                ...state.playback,
                songKey: expectedSongKey,
                positionMs,
                seeking: true
            };
            result = { accepted: true, command: command.command, positionMs, expectedSongKey };
            break;
        }
        case 'settings':
            state.settings = {
                order: mergeSettings({ order: { ...state.settings.order, ...(value?.order || {}) } }).order,
                login: value?.login && typeof value.login === 'object'
                    ? { ...state.settings.login, ...value.login }
                    : state.settings.login
            };
            localStore.updateSettings(roomId, { order: state.settings.order, login: state.settings.login }, null);
            if (value?.display && typeof value.display === 'object') {
                localStore.updateSettings(null, { display: value.display }, null);
            }
            if (value?.login?.songListId) state.songListId = String(value.login.songListId);
            break;
        case 'pause':
        case 'toggle':
        case 'unlockAudio':
            break;
        default:
            break;
    }
    state.commandResult = result;
    state.playbackAction = command.command;
    state.playbackActionId = String(command.id || '');
    if (result.accepted === false) return { state, result };
    const shouldBumpRevision = !(result.moved === false || result.reason === 'already-next' || result.reason === 'already-ordered');
    const persisted = persistRoomState(roomId, state, {
        bumpRevision: shouldBumpRevision,
        bumpQueueRevision: queueChanged
    });
    if (queueChanged) {
        result.stateRevision = persisted.stateRevision;
        result.queueRevision = persisted.queueRevision;
    }
    return { state: persisted, result };
}

const MIXIN_KEY_TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];

function wbiSign(params, mixinKey) {
    const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(signed).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(signed[key]).replace(/[!'()*]/g, ''))}`).join('&');
    return { ...signed, w_rid: crypto.createHash('md5').update(query + mixinKey).digest('hex') };
}

// 兼容直播姬等内置 WebView：部分版本会把本地页面当作不同安全上下文，
// 对 JSON POST 先发 OPTIONS 预检。普通同源页面不会受到影响。
router.use((req, res, next) => {
    if (req.path.startsWith('/live/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
});

// 给可能仍在浏览器缓存中的页面提供轻量级后端探针。
router.get('/live/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code: 0, data: { service: 'order', pid: process.pid, now: Date.now(), buildId: process.env.DAMUKU_BUILD_ID || '' } });
});

router.get('/live/settings', (req, res) => {
    const roomId = String(req.query.room_id || req.query.roomid || 'default');
    const room = readRoomState(roomId);
    const global = localStore.getSettings(null);
    const roomSettings = localStore.getSettings(roomId);
    const globalPath = localStore.settingsPath(null);
    const roomPath = localStore.settingsPath(roomId);
    const hasRoomSettings = fs.existsSync(roomPath);
    res.json({
        code: 0,
        data: {
            revision: Math.max(global.revision || 0, roomSettings.revision || 0),
            globalRevision: global.revision || 0,
            roomRevision: roomSettings.revision || 0,
            hasStored: fs.existsSync(globalPath) || hasRoomSettings ||
                Number(room.stateRevision || 0) > 0 || Boolean(room.songListId),
            order: hasRoomSettings ? roomSettings.order : global.order,
            display: global.display,
            login: room.settings?.login || null,
            volume: room.volume
        }
    });
});

router.put('/live/settings', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const incoming = req.body?.settings || {};
    const current = readRoomState(roomId);
    const expectedRevision = req.body?.revision;
    const expectedGlobalRevision = req.body?.globalRevision;
    const expectedRoomRevision = req.body?.roomRevision;
    const currentGlobal = localStore.getSettings(null);
    const currentRoom = localStore.getSettings(roomId);
    const roomRevision = Number(currentRoom.revision || 0);
    const globalRevision = Number(currentGlobal.revision || 0);
    const roomExpected = expectedRoomRevision ?? expectedRevision;
    if ((roomExpected != null && Number(roomExpected) !== roomRevision) ||
        (expectedGlobalRevision != null && Number(expectedGlobalRevision) !== globalRevision)) {
        return res.status(409).json({ code: -1, message: '设置版本已更新', data: current.settings });
    }
    const hasRoomPatch = incoming.order != null || incoming.login != null;
    const savedRoom = hasRoomPatch
        ? localStore.updateSettings(roomId, {
            order: incoming.order,
            login: incoming.login
        }, null)
        : { ok: true, settings: currentRoom };
    const savedGlobal = incoming.display
        ? localStore.updateSettings(null, { display: incoming.display }, expectedGlobalRevision ?? null)
        : { ok: true, settings: currentGlobal };
    if (!savedRoom.ok || !savedGlobal.ok) {
        return res.status(409).json({ code: -1, message: '设置版本已更新', data: current.settings });
    }
    const next = {
        ...current,
        settings: {
            ...current.settings,
            order: savedRoom.settings.order,
            login: incoming.login || current.settings.login
        }
    };
    const persisted = persistRoomState(roomId, next);
    res.json({
        code: 0,
        data: {
            ...savedRoom.settings,
            display: savedGlobal.settings.display,
            globalRevision: savedGlobal.settings.revision,
            roomRevision: savedRoom.settings.revision,
            revision: Math.max(savedGlobal.settings.revision, savedRoom.settings.revision),
            login: persisted.settings.login
        },
        state: persisted
    });
});

// 让控制页和 OBS 播放页使用同一份网易云登录态。
// 这是本机页面之间的临时同步，服务重启后会自动清空，不会落盘。
router.get('/live/sync-credentials', (req, res) => {
    const roomId = String(req.query.room_id || req.query.roomid || 'default');
    const cookie = sharedRuntimeCredentials.get(roomId) || localStore.getNeteaseCookie();
    res.json({ code: 0, data: { hasNeteaseCookie: Boolean(cookie) } });
});

router.post('/live/sync-credentials', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const cookie = req.body?.netease_cookie;
    if (typeof cookie === 'string' && cookie.trim()) {
        sharedRuntimeCredentials.set(roomId, cookie);
        localStore.saveNeteaseCookie(cookie);
    }
    res.json({
        code: 0,
        data: { hasNeteaseCookie: Boolean(sharedRuntimeCredentials.get(roomId)) }
    });
});

router.delete('/live/sync-credentials', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || req.query.room_id || 'default');
    sharedRuntimeCredentials.delete(roomId);
    localStore.clearNeteaseCookie();
    res.json({ code: 0, data: { hasNeteaseCookie: false } });
});

// OBS 浏览器源与外部浏览器之间的点歌状态同步
router.get('/live/sync-state', (req, res) => {
    const roomId = String(req.query.room_id || req.query.roomid || 'default');
    const stateFile = syncFilePath('state', roomId);
    const exists = fs.existsSync(stateFile) || sharedOrderStates.has(roomId);
    res.json({ code: 0, data: exists ? readRoomState(roomId) : null });
});

// 为房间申请唯一播放端租约。普通浏览器打开 OBS 链接时，如果已经有
// OBS 播放页在线，会在这里被识别为监控页，避免它再加载自己的歌单并播放。
router.post('/live/sync-claim', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const publisherId = String(req.body?.publisherId || '');
    if (!publisherId) {
        return res.status(400).json({ code: -1, message: 'publisherId必须存在' });
    }

    const current = readRoomState(roomId);
    const currentPublisherId = String(current?.publisherId || '');
    const currentHeartbeatAt = Number(current?.publisherHeartbeatAt || current?.updatedAt || 0);
    const publisherLeaseActive = current && currentPublisherId &&
        Date.now() - currentHeartbeatAt < SYNC_PUBLISHER_LEASE_MS;

    if (publisherLeaseActive && currentPublisherId !== publisherId) {
        return res.json({ code: 0, data: current, claimed: false, ignored: true, reason: 'publisher-locked' });
    }

    const now = Date.now();
    const nextState = {
        ...current,
        publisherId,
        stateRevision: (Number(current.stateRevision) || 0) + 1,
        publisherStartedAt: publisherLeaseActive
            ? Number(current.publisherStartedAt) || now
            : now,
        publisherHeartbeatAt: now,
        updatedAt: now
    };
    writeSyncFile(syncFilePath('state', roomId), nextState);
    sharedOrderStates.set(roomId, nextState);
    res.json({ code: 0, data: nextState, claimed: true });
});

router.post('/live/sync-state', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const state = req.body?.state;
    if (!state || typeof state !== 'object') {
        return res.status(400).json({ code: -1, message: 'state必须是对象' });
    }
    const current = readRoomState(roomId);
    const incomingPublisherId = String(state.publisherId || '');
    const currentPublisherId = String(current.publisherId || '');
    const currentHeartbeatAt = Number(current.publisherHeartbeatAt || current.updatedAt || 0);
    const publisherLeaseActive = currentPublisherId &&
        Date.now() - currentHeartbeatAt < SYNC_PUBLISHER_LEASE_MS;

    // 一个房间只允许当前 OBS 播放页发布状态，避免旧 OBS 页或另一个普通播放页
    // 在切歌期间把控制页覆盖回另一首歌。发布者停止心跳后，新的页面才能接管。
    if (publisherLeaseActive && incomingPublisherId !== currentPublisherId) {
        return res.json({ code: 0, data: current, ignored: true, reason: 'publisher-locked' });
    }
    if (publisherLeaseActive && currentPublisherId && !incomingPublisherId) {
        return res.json({ code: 0, data: current, ignored: true, reason: 'publisher-required' });
    }
    // 浏览器只上报播放端遥测，不能再用本地 queue/current/歌单覆盖后端权威状态。
    // 这样控制页、OBS、直播姬内置 WebView 看到的永远是同一份队列。
    const hasCanonicalState = current.stateRevision > 0 || current.queue.length ||
        current.currentSong || current.idleSongList.length || current.songListId;
    const canonical = hasCanonicalState ? current : normalizeRoomState(state);
    const nextState = {
        ...canonical,
        status: state.status || canonical.status,
        volume: state.volume == null ? canonical.volume : state.volume,
        audioUnlockRequired: Boolean(state.audioUnlockRequired),
        playback: state.playback || canonical.playback,
        settings: {
            order: state.settings?.order || canonical.settings.order || null,
            login: state.settings?.login || canonical.settings.login || null
        },
        publisherId: incomingPublisherId || (publisherLeaseActive ? currentPublisherId : canonical.publisherId),
        publisherStartedAt: Number(state.publisherStartedAt) || canonical.publisherStartedAt || Date.now(),
        publisherHeartbeatAt: Date.now()
    };
    if (nextState.settings.login?.songListId && !nextState.songListId) {
        nextState.songListId = String(nextState.settings.login.songListId);
    }
    const persisted = persistRoomState(roomId, nextState);
    res.json({ code: 0, data: persisted });
});

router.post('/live/sync-command', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const command = req.body?.command;
    if (!command || typeof command !== 'object') {
        return res.status(400).json({ code: -1, message: 'command必须是对象' });
    }
    const allowedCommands = new Set([
        'loadSongList', 'addOrder', 'next', 'play', 'volume', 'settings',
        'pause', 'toggle', 'unlockAudio', 'promoteNext', 'reorderQueue', 'removeOrder', 'seek'
    ]);
    if (!allowedCommands.has(String(command.command || ''))) {
        return res.status(400).json({ code: -1, message: '不支持的控制指令' });
    }
    if (['promoteNext', 'reorderQueue', 'removeOrder'].includes(command.command)) {
        const value = command.value;
        const allowedFields = command.command === 'promoteNext'
            ? ['orderId', 'expectedRevision', 'expectedQueueRevision', 'expectedCurrentOrderId']
            : command.command === 'removeOrder'
                ? ['orderId', 'expectedQueueRevision', 'expectedCurrentOrderId']
                : ['expectedQueueRevision', 'expectedCurrentOrderId', 'pendingOrderIds'];
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).some(key => !allowedFields.includes(key))) {
            return res.status(400).json({ code: -1, message: '队列控制参数无效' });
        }
    }
    if (command.command === 'seek') {
        const value = command.value;
        const allowedFields = ['positionMs', 'expectedSongKey'];
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).some(key => !allowedFields.includes(key))) {
            return res.status(400).json({ code: -1, message: 'seek参数无效' });
        }
    }
    const filePath = commandLogPath(roomId);
    const list = sharedOrderCommands.get(roomId) || readCommandLog(filePath);
    const lastSequence = list.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0);
    const nextCommand = {
        ...command,
        sequence: Math.max(sharedOrderCommandSeq, lastSequence) + 1,
        createdAt: Date.now()
    };
    const applied = applyRoomCommand(roomId, nextCommand);
    const canonicalState = applied.state;
    // 命令日志只保留最小执行摘要，完整 idleSongList/currentSong 只存在状态文件。
    const logEntry = {
        sequence: nextCommand.sequence,
        id: nextCommand.id || '',
        command: nextCommand.command,
        value: nextCommand.command === 'loadSongList'
            ? {
                requestId: nextCommand.value?.requestId || nextCommand.requestId || '',
                platform: nextCommand.value?.platform || '',
                listId: nextCommand.value?.listId || ''
            }
            : nextCommand.command === 'volume' ? nextCommand.value
                    : ['promoteNext', 'reorderQueue', 'removeOrder'].includes(nextCommand.command)
                        ? {
                            orderId: nextCommand.value?.orderId || '',
                        expectedRevision: nextCommand.value?.expectedRevision,
                        expectedQueueRevision: nextCommand.value?.expectedQueueRevision,
                        expectedCurrentOrderId: nextCommand.value?.expectedCurrentOrderId || '',
                            pendingOrderIds: Array.isArray(nextCommand.value?.pendingOrderIds)
                                ? nextCommand.value.pendingOrderIds.slice(0, MAX_QUEUE_REORDER_ITEMS)
                                : undefined,
                            removeOrder: nextCommand.command === 'removeOrder'
                        }
                    : nextCommand.command === 'seek' ? {
                        positionMs: nextCommand.value?.positionMs,
                        expectedSongKey: nextCommand.value?.expectedSongKey || ''
                    } : undefined,
        createdAt: nextCommand.createdAt,
        stateRevision: canonicalState.stateRevision,
        result: applied.result
    };
    sharedOrderCommandSeq = nextCommand.sequence;
    const nextList = appendCommandLog(filePath, logEntry, list);
    sharedOrderCommands.set(roomId, nextList);
    const responseStatus = applied.result.accepted === false
        ? (Number(applied.result.httpStatus) || 400)
        : 200;
    res.status(responseStatus).json({
        code: applied.result.accepted === false ? -1 : 0,
        data: canonicalState,
        result: applied.result
    });
});

router.get('/live/sync-commands', (req, res) => {
    const roomId = String(req.query.room_id || req.query.roomid || 'default');
    const after = Number(req.query.after || 0);
    const since = Number(req.query.since || 0);
    const commands = (sharedOrderCommands.get(roomId) || readCommandLog(commandLogPath(roomId)))
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
