const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const encrypt = require('../utils/encrypt');
const { LocalStore, mergeSettings } = require('../services/local-store');
const { getBiliSession } = require('../services/bili-session');
const { getAttachedLiveDanmuHub } = require('../services/bili-live-ws');

// 创建axios实例，指向B站开放平台
const api = axios.create({
    baseURL: "https://live-open.biliapi.com"
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
const sharedLyricsSnapshots = new Map();
const sharedCandidates = new Map();
const sharedRoomLocks = new Map();
const sharedAutoSwitchStates = new Map();
const sharedAutoSwitchInFlight = new Map();
const historyDiagnostics = new Map();
const localStore = new LocalStore(path.resolve(__dirname, '../..'));
let sharedOrderCommandSeq = 0;
// OBS 最小化后，内置 Chromium 可能把页面定时器延迟数秒甚至更久。
// 5 秒租约会把仍在播放的 OBS 误判为离线，导致播放端被重新接管。
const SYNC_PUBLISHER_LEASE_MS = 60 * 1000;
const SYNC_CANDIDATE_TTL_MS = 8 * 1000;
const SYNC_HANDOFF_DEADLINE_MS = 5 * 1000;
const SYNC_AUTO_TARGET_FRESH_MS = 3 * 1000;
const SYNC_AUTO_LEADING_GAP_MS = 2 * 1000;
const SYNC_AUTO_STABLE_ROUNDS = 2;
const MAX_SCENE_CANDIDATES = 32;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const sharedSyncDir = localStore.cacheDir;
fs.mkdirSync(sharedSyncDir, { recursive: true });
const MAX_COMMAND_LOG_ENTRIES = 1000;
const MAX_COMMAND_LOG_BYTES = 512 * 1024;
const COMMAND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUEUE_REORDER_ITEMS = 5000;

function syncFilePath(prefix, roomId) {
    return path.join(sharedSyncDir, `${prefix}-${String(roomId).replace(/[^0-9a-z_-]/gi, '_')}.json`);
}

function lyricsFilePath(roomId, songKeyValue) {
    const safeRoom = String(roomId).replace(/[^0-9a-z_-]/gi, '_');
    const safeSong = String(songKeyValue || 'unknown').replace(/[^0-9a-z_.-]/gi, '_');
    return path.join(sharedSyncDir, `lyrics-${safeRoom}-${safeSong}.json`);
}

function createLeaseToken() {
    return crypto.randomBytes(24).toString('base64url');
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
        lyrics: {
            songKey: '',
            status: 'unknown',
            revision: 0,
            contentHash: '',
            updatedAt: 0
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
        publisher: {
            publisherId: null,
            instanceId: '',
            generation: 0,
            leaseToken: '',
            status: 'released',
            heartbeatAt: 0
        },
        publisherGeneration: 0,
        publisherLeaseToken: '',
        publisherInstanceId: '',
        publisherStartedAt: 0,
        publisherHeartbeatAt: 0,
        handoff: null,
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
        paused: playback?.paused == null ? true : Boolean(playback.paused),
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
    const sourcePublisher = input.publisher && typeof input.publisher === 'object' ? input.publisher : {};
    const publisherId = String(sourcePublisher.publisherId || input.publisherId || '').trim();
    const generation = Math.max(0, Number(sourcePublisher.generation ?? input.publisherGeneration) || 0);
    const leaseToken = String(sourcePublisher.leaseToken || input.publisherLeaseToken || '');
    const heartbeatAt = Number(sourcePublisher.heartbeatAt || input.publisherHeartbeatAt || 0) || 0;
    return {
        ...defaults,
        ...input,
        queue,
        currentSong,
        playback: normalizePlayback(input.playback, currentSong),
        lyrics: {
            ...defaults.lyrics,
            ...(input.lyrics && typeof input.lyrics === 'object' ? input.lyrics : {}),
            songKey: String(input.lyrics?.songKey || ''),
            status: String(input.lyrics?.status || 'unknown'),
            revision: Math.max(0, Number(input.lyrics?.revision) || 0),
            contentHash: String(input.lyrics?.contentHash || ''),
            updatedAt: Number(input.lyrics?.updatedAt) || 0
        },
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
        lastSongListRequestId: String(input.lastSongListRequestId || ''),
        publisherId,
        publisher: {
            publisherId,
            instanceId: String(sourcePublisher.instanceId || input.publisherInstanceId || ''),
            generation,
            leaseToken,
            status: String(sourcePublisher.status || (publisherId ? 'active' : 'released')),
            heartbeatAt
        },
        publisherGeneration: generation,
        publisherLeaseToken: leaseToken,
        publisherInstanceId: String(sourcePublisher.instanceId || input.publisherInstanceId || ''),
        handoff: normalizeHandoff(input)
    };
}

function candidateFilePath(roomId) {
    return syncFilePath('candidates', roomId);
}

function handoffEnabled(roomId) {
    return localStore.getSettings(null).display.multiSceneHandoffEnabled === true;
}

function trustedLocalOrigin(req) {
    const origin = req.get('origin');
    if (!origin) return true;
    try {
        const hostname = new URL(origin).hostname.toLowerCase();
        const requestHost = String(req.hostname || '').toLowerCase();
        const loopback = new Set(['localhost', '127.0.0.1', '::1']);
        return hostname === requestHost || (loopback.has(hostname) && loopback.has(requestHost));
    } catch (_) {
        return false;
    }
}

function readCandidates(roomId) {
    const stored = readSyncFile(candidateFilePath(roomId), sharedCandidates.get(roomId) || {});
    const source = stored && typeof stored === 'object' ? stored : {};
    const cutoff = Date.now() - SYNC_CANDIDATE_TTL_MS;
    const candidates = {};
    let changed = false;
    Object.keys(source).forEach(instanceId => {
        const original = source[instanceId];
        const rawActivations = Array.isArray(original?.activations)
            ? original.activations
            : [original];
        const activations = rawActivations
            .filter(item => item && INSTANCE_ID_PATTERN.test(String(item.instanceId || instanceId)) &&
                String(item.activationId || '').trim() && Number(item.lastSeenAt) >= cutoff)
            .map(item => ({
                instanceId: String(item.instanceId || instanceId),
                publisherId: String(item.publisherId || '').trim(),
                activationId: String(item.activationId || '').trim(),
                role: 'obs',
                handoff: 'scene',
                lastSeenAt: Number(item.lastSeenAt) || 0,
                firstSeenAt: Number(item.firstSeenAt) || Number(item.lastSeenAt) || 0,
                heartbeatCount: Math.max(0, Number(item.heartbeatCount) || 0),
                heartbeatCountSinceSuperseded: Math.max(0, Number(item.heartbeatCountSinceSuperseded) || Number(item.heartbeatCount) || 0),
                lastHeartbeatSequence: Number(item.lastHeartbeatSequence) || 0,
                supersededAt: Number(item.supersededAt) || 0,
                supersededBy: String(item.supersededBy || ''),
                status: 'candidate'
            }));
        if (!activations.length) {
            changed = true;
            return;
        }
        const latest = activations.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
        const freshActivationCount = activations.filter(item => Date.now() - Number(item.lastSeenAt || 0) <= SYNC_AUTO_TARGET_FRESH_MS).length;
        const conflict = hasConcurrentActivations(activations);
        candidates[instanceId] = {
            ...latest,
            activations,
            conflict,
            reloading: activations.length > 1 && !conflict,
            activationCount: activations.length,
            freshActivationCount
        };
        if (!Array.isArray(original?.activations) || original.activationCount !== activations.length ||
            original.freshActivationCount !== freshActivationCount || Boolean(original.conflict) !== conflict ||
            Boolean(original.reloading) !== (activations.length > 1 && !conflict)) {
            changed = true;
        }
    });
    sharedCandidates.set(roomId, candidates);
    if (changed) writeSyncFile(candidateFilePath(roomId), candidates);
    return candidates;
}

function writeCandidates(roomId, candidates) {
    sharedCandidates.set(roomId, candidates);
    writeSyncFile(candidateFilePath(roomId), candidates);
    return candidates;
}

function clearCandidates(roomId) {
    sharedCandidates.delete(roomId);
    try { fs.unlinkSync(candidateFilePath(roomId)); } catch (_) { /* already absent */ }
}

function candidateIsOnline(candidate) {
    return Boolean(candidate && Date.now() - Number(candidate.lastSeenAt || 0) <= SYNC_CANDIDATE_TTL_MS);
}

function candidateHasActivation(candidate, activationId) {
    const id = String(activationId || '').trim();
    if (!id || !candidate) return false;
    if (Array.isArray(candidate.activations)) return candidate.activations.some(item => item.activationId === id && candidateIsOnline(item));
    return candidate.activationId === id && candidateIsOnline(candidate);
}

function getCandidateActivation(candidate, activationId = '') {
    if (!candidate) return null;
    const id = String(activationId || '').trim();
    if (id && Array.isArray(candidate.activations)) {
        return candidate.activations.find(item => item.activationId === id) || null;
    }
    return candidate;
}

function candidateIsConflicted(candidate) {
    return Boolean(candidate?.conflict);
}

function hasConcurrentActivations(activations) {
    const now = Date.now();
    const fresh = (activations || []).filter(item => item && now - Number(item.lastSeenAt || 0) <= SYNC_AUTO_TARGET_FRESH_MS);
    for (let i = 0; i < fresh.length; i += 1) {
        for (let j = i + 1; j < fresh.length; j += 1) {
            const a = fresh[i];
            const b = fresh[j];
            if (Number(a.heartbeatCountSinceSuperseded || 0) < 2 || Number(b.heartbeatCountSinceSuperseded || 0) < 2) continue;
            if (a.supersededAt && Number(a.lastSeenAt) <= Number(a.supersededAt)) continue;
            if (b.supersededAt && Number(b.lastSeenAt) <= Number(b.supersededAt)) continue;
            if (Number(a.lastSeenAt) >= Number(b.firstSeenAt || 0) && Number(b.lastSeenAt) >= Number(a.firstSeenAt || 0)) return true;
        }
    }
    return false;
}

function autoSwitchSettings() {
    const display = localStore.getSettings(null).display || {};
    return {
        enabled: display.multiSceneHandoffEnabled === true,
        autoEnabled: display.multiSceneAutoSwitchEnabled === true,
        thresholdMs: Math.max(4000, Math.min(8000, Number(display.multiSceneHeartbeatThresholdMs) || 5000))
    };
}

function evaluateAutoSwitch(roomId, state, candidates) {
    const config = autoSwitchSettings();
    const previous = sharedAutoSwitchStates.get(roomId) || {};
    if (['completed', 'failed'].includes(previous.state) && Number(previous.completedAt || previous.failedAt || 0) + 5000 > Date.now()) {
        return previous;
    }
    if (!config.enabled || !config.autoEnabled) {
        const disabled = { state: config.enabled ? 'disabled' : 'disabled', reason: config.enabled ? 'auto-switch-disabled' : 'scene-handoff-disabled', thresholdMs: config.thresholdMs, stableRounds: 0 };
        sharedAutoSwitchStates.set(roomId, disabled);
        return disabled;
    }
    const now = Date.now();
    const current = currentPublisherInfo(state);
    const handoff = normalizeHandoff(state);
    const currentPublisherAgeMs = current.heartbeatAt ? Math.max(0, now - current.heartbeatAt) : Number.MAX_SAFE_INTEGER;
    const currentCandidate = candidates[current.instanceId];
    const previousPublisherAgeMs = currentCandidate?.lastSeenAt
        ? Math.max(currentPublisherAgeMs, now - Number(currentCandidate.lastSeenAt))
        : currentPublisherAgeMs;
    const publisherUnavailable = current.status === 'released' || !current.publisherId || previousPublisherAgeMs > config.thresholdMs;
    const freshCandidates = Object.values(candidates)
        .filter(candidate => candidateIsOnline(candidate) && !candidateIsConflicted(candidate))
        .map(candidate => ({ ...candidate, heartbeatAgeMs: Math.max(0, now - Number(candidate.lastSeenAt || 0)) }))
        .filter(candidate => candidate.heartbeatAgeMs <= SYNC_AUTO_TARGET_FRESH_MS)
        .sort((a, b) => a.heartbeatAgeMs - b.heartbeatAgeMs || String(a.instanceId).localeCompare(String(b.instanceId)));
    const eligibleTargets = freshCandidates.filter(candidate => candidate.instanceId !== current.instanceId);
    // 旧 publisher 已明确 release/过期后，其残留 candidate 不应继续阻挡唯一新目标。
    const comparisonCandidates = publisherUnavailable
        ? freshCandidates.filter(candidate => candidate.instanceId !== current.instanceId)
        : freshCandidates;
    let next = {
        enabled: true,
        state: 'waiting',
        reason: publisherUnavailable ? 'waiting-for-unique-fresh-candidate' : 'current-publisher-active',
        thresholdMs: config.thresholdMs,
        winnerAgeMs: freshCandidates[0]?.heartbeatAgeMs ?? null,
        previousPublisherAgeMs: Number.isFinite(previousPublisherAgeMs) ? previousPublisherAgeMs : null,
        stableRounds: 0
    };
    if (!publisherUnavailable) {
        sharedAutoSwitchStates.set(roomId, next);
        return next;
    }
    if (eligibleTargets.length !== 1) {
        next.state = eligibleTargets.length > 1 ? 'ambiguous' : 'waiting';
        next.reason = eligibleTargets.length > 1 ? 'multiple-fresh-candidates' : 'no-unique-fresh-candidate';
        next.stableRounds = 0;
        sharedAutoSwitchStates.set(roomId, next);
        return next;
    }
    const winner = eligibleTargets[0];
    const second = comparisonCandidates.find(candidate => candidate.instanceId !== winner.instanceId);
    const leadMs = second ? Math.max(0, second.heartbeatAgeMs - winner.heartbeatAgeMs) : Number.MAX_SAFE_INTEGER;
    const sameWinner = previous.targetInstanceId === winner.instanceId && previous.targetActivationId === winner.activationId;
    const stableRounds = sameWinner ? Number(previous.stableRounds || 0) + 1 : 1;
    next.targetInstanceId = winner.instanceId;
    next.targetActivationId = winner.activationId;
    next.winnerAgeMs = winner.heartbeatAgeMs;
    next.leadMs = leadMs;
    next.stableRounds = stableRounds;
    if (leadMs < SYNC_AUTO_LEADING_GAP_MS || stableRounds < SYNC_AUTO_STABLE_ROUNDS) {
        next.reason = leadMs < SYNC_AUTO_LEADING_GAP_MS ? 'insufficient-heartbeat-lead' : 'stabilizing-winner';
        sharedAutoSwitchStates.set(roomId, next);
        return next;
    }
    if (handoff && ['revoke-pending', 'target-pending'].includes(handoff.state)) {
        next.state = 'switching';
        next.reason = 'switch-in-progress';
        sharedAutoSwitchStates.set(roomId, next);
        return next;
    }
    next.state = 'switching';
    next.reason = 'heartbeat-threshold-reached';
    next.shouldSwitch = true;
    next.switchId = `auto-${String(roomId).replace(/[^0-9a-z_-]/gi, '_')}-${winner.activationId}`.slice(0, 200);
    sharedAutoSwitchStates.set(roomId, next);
    return next;
}

async function evaluateAndRequestAutoSwitchLocked(roomId, state, candidates) {
    const autoSwitch = evaluateAutoSwitch(roomId, state, candidates);
    if (!autoSwitch.shouldSwitch || sharedAutoSwitchInFlight.has(roomId)) return autoSwitch;
    sharedAutoSwitchInFlight.set(roomId, autoSwitch.switchId);
    const current = currentPublisherInfo(state);
    const target = candidates[autoSwitch.targetInstanceId];
    console.info('[AUTO_TARGET_SELECTED]', { roomId, switchId: autoSwitch.switchId, targetInstanceId: autoSwitch.targetInstanceId, targetActivationId: target?.activationId || '', generation: current.generation });
    try {
        const result = await requestSceneSwitchLocked(roomId, {
            targetInstanceId: autoSwitch.targetInstanceId,
            targetActivationId: target?.activationId || '',
            switchId: autoSwitch.switchId,
            expectedGeneration: current.generation,
            expectedInstanceId: current.instanceId,
            automatic: true
        });
        const latest = { ...(sharedAutoSwitchStates.get(roomId) || autoSwitch), targetInstanceId: autoSwitch.targetInstanceId, targetActivationId: target?.activationId || '', switchId: autoSwitch.switchId };
        latest.state = result.status === 200 ? 'switching' : 'failed';
        latest.reason = result.status === 200 ? 'target-awaiting-claim' : (result.body?.reason || 'auto-switch-failed');
        latest.accepted = result.status === 200;
        sharedAutoSwitchStates.set(roomId, latest);
        console.info(result.status === 200 ? '[AUTO_SWITCH_ACCEPTED]' : '[AUTO_TARGET_NOTIFIED]', { roomId, switchId: autoSwitch.switchId, targetInstanceId: autoSwitch.targetInstanceId, targetActivationId: target?.activationId || '', handoffState: result.body?.result?.state || '' });
        return latest;
    } catch (error) {
        const failed = { ...(sharedAutoSwitchStates.get(roomId) || autoSwitch), state: 'failed', reason: error?.message || 'auto-switch-failed', switchId: autoSwitch.switchId };
        sharedAutoSwitchStates.set(roomId, failed);
        return failed;
    } finally {
        sharedAutoSwitchInFlight.delete(roomId);
    }
}

function withRoomLock(roomId, task) {
    const previous = sharedRoomLocks.get(roomId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    sharedRoomLocks.set(roomId, current);
    return previous.then(async () => {
        const lockPath = syncFilePath('room-lock', roomId);
        let lockHandle = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
                lockHandle = fs.openSync(lockPath, 'wx');
                break;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                try {
                    if (Date.now() - fs.statSync(lockPath).mtimeMs > 15_000) fs.unlinkSync(lockPath);
                } catch (_) { /* another process may own or remove it */ }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        if (lockHandle == null) throw new Error('room-lock-timeout');
        try {
            return await task();
        } finally {
            try { fs.closeSync(lockHandle); } catch (_) { }
            try { fs.unlinkSync(lockPath); } catch (_) { }
        }
    }).finally(() => {
        release();
        if (sharedRoomLocks.get(roomId) === current) sharedRoomLocks.delete(roomId);
    });
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

function currentPublisherInfo(state) {
    const publisher = state?.publisher && typeof state.publisher === 'object' ? state.publisher : {};
    return {
        publisherId: String(publisher.publisherId || state?.publisherId || ''),
        instanceId: String(publisher.instanceId || state?.publisherInstanceId || ''),
        generation: Math.max(0, Number(publisher.generation ?? state?.publisherGeneration) || 0),
        leaseToken: String(publisher.leaseToken || state?.publisherLeaseToken || ''),
        status: String(publisher.status || (state?.publisherId ? 'active' : 'released')),
        heartbeatAt: Number(publisher.heartbeatAt || state?.publisherHeartbeatAt || state?.updatedAt || 0) || 0
    };
}

function requestPublisherInfo(body = {}, command = null) {
    const source = body.publisher && typeof body.publisher === 'object'
        ? body.publisher
        : (command && command.publisher && typeof command.publisher === 'object' ? command.publisher : body);
    return {
        publisherId: String(source.publisherId || command?.publisherId || '').trim(),
        instanceId: String(source.instanceId || source.publisherInstanceId || command?.instanceId || '').trim(),
        generation: source.generation == null && source.publisherGeneration == null
            ? null
            : Number(source.generation ?? source.publisherGeneration),
        leaseToken: String(source.leaseToken || source.publisherLeaseToken || command?.leaseToken || '')
    };
}

function publisherAuthResult(state, incoming, { allowLegacy = true } = {}) {
    const current = currentPublisherInfo(state);
    const active = Boolean(current.publisherId && current.status === 'active' &&
        Date.now() - current.heartbeatAt < SYNC_PUBLISHER_LEASE_MS);
    if (!incoming.publisherId && allowLegacy) return { ok: true, legacy: true, active, current };
    if (!incoming.publisherId || !current.publisherId || incoming.publisherId !== current.publisherId) {
        return { ok: false, reason: active ? 'publisher-locked' : 'publisher-required', current, active };
    }
    if (incoming.generation != null && (!Number.isFinite(incoming.generation) || incoming.generation !== current.generation)) {
        return { ok: false, reason: 'stale-publisher', current, active };
    }
    if (incoming.leaseToken && incoming.leaseToken !== current.leaseToken) {
        return { ok: false, reason: 'fenced', current, active };
    }
    if (current.status === 'released') return { ok: false, reason: 'publisher-released', current, active };
    if (!active && current.status !== 'released') return { ok: false, reason: 'publisher-expired', current, active };
    return { ok: true, legacy: incoming.generation == null && !incoming.leaseToken, active, current };
}

function normalizeLyricsPayload(lyrics) {
    const source = lyrics && typeof lyrics === 'object' ? lyrics : {};
    const normalizeLines = value => Array.isArray(value) ? value.slice(0, 20000).map(line => ({
        startMs: Math.max(0, Number(line?.startMs ?? line?.timeMs) || 0),
        endMs: Math.max(0, Number(line?.endMs) || 0),
        text: String(line?.text || ''),
        ...(line?.translation ? { translation: String(line.translation) } : {})
    })) : [];
    return {
        original: normalizeLines(source.original || source.lines),
        translation: normalizeLines(source.translation),
        romanized: normalizeLines(source.romanized || source.romanization),
        noLyrics: Boolean(source.noLyrics),
        parserVersion: Math.max(1, Number(source.parserVersion) || 1)
    };
}

function readLyricsSnapshot(roomId, key) {
    const cacheKey = `${roomId}:${key}`;
    const stored = readSyncFile(lyricsFilePath(roomId, key), null);
    const snapshot = stored || sharedLyricsSnapshots.get(cacheKey) || null;
    if (snapshot) sharedLyricsSnapshots.set(cacheKey, snapshot);
    return snapshot;
}

function appendHandoffCommand(roomId, command) {
    const filePath = commandLogPath(roomId);
    const list = sharedOrderCommands.get(roomId) || readCommandLog(filePath);
    const lastSequence = list.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0);
    const next = {
        ...command,
        type: 'command',
        id: command.id || `handoff-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        sequence: Math.max(sharedOrderCommandSeq, lastSequence) + 1,
        createdAt: Date.now()
    };
    sharedOrderCommandSeq = next.sequence;
    const logEntry = {
        sequence: next.sequence,
        id: next.id,
        command: next.command,
        switchId: next.switchId || '',
        targetInstanceId: next.targetInstanceId || '',
        targetPublisherId: next.targetPublisherId || '',
        generation: next.generation,
        createdAt: next.createdAt
    };
    const retained = appendCommandLog(filePath, logEntry, list);
    sharedOrderCommands.set(roomId, retained);
    return next;
}

function normalizeHandoff(state) {
    if (!state?.handoff || typeof state.handoff !== 'object') return null;
    const value = state.handoff;
    return {
        switchId: String(value.switchId || ''),
        targetInstanceId: String(value.targetInstanceId || ''),
        targetActivationId: String(value.targetActivationId || ''),
        expectedGeneration: Number(value.expectedGeneration) || 0,
        expectedInstanceId: String(value.expectedInstanceId || ''),
        state: String(value.state || 'idle'),
        deadline: Number(value.deadline) || 0,
        createdAt: Number(value.createdAt) || 0,
        revokeAckAt: Number(value.revokeAckAt) || 0,
        result: value.result && typeof value.result === 'object' ? value.result : null,
        oldPublisher: value.oldPublisher && typeof value.oldPublisher === 'object' ? value.oldPublisher : null,
        automatic: value.automatic === true
    };
}

function expireHandoff(roomId, state) {
    const handoff = normalizeHandoff(state);
    if (!handoff || !['revoke-pending', 'target-pending'].includes(handoff.state) || !handoff.deadline || Date.now() <= handoff.deadline) {
        return state;
    }
    handoff.state = 'failed';
    handoff.result = {
        accepted: false,
        switchId: handoff.switchId,
        state: 'failed',
        reason: 'target-timeout'
    };
    const persisted = persistRoomState(roomId, { ...state, handoff });
    if (handoff.automatic) {
        const previous = sharedAutoSwitchStates.get(roomId) || {};
        sharedAutoSwitchStates.set(roomId, { ...previous, state: 'failed', switchId: handoff.switchId, targetInstanceId: handoff.targetInstanceId, targetActivationId: handoff.targetActivationId, reason: 'target-timeout', failedAt: Date.now() });
        console.warn('[AUTO_SWITCH_TIMEOUT]', { roomId, switchId: handoff.switchId, targetInstanceId: handoff.targetInstanceId, targetActivationId: handoff.targetActivationId, handoffState: handoff.state });
    }
    return persisted;
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
    if (savedGlobal.settings.display.multiSceneHandoffEnabled !== true) clearCandidates(roomId);
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

router.post('/live/sync-candidate', async (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    if (!handoffEnabled(roomId)) {
        clearCandidates(roomId);
        return res.status(409).json({ code: -1, enabled: false, reason: 'scene-handoff-disabled' });
    }
    const instanceId = String(req.body?.instanceId || '').trim();
    const publisherId = String(req.body?.publisherId || '').trim();
    const activationId = String(req.body?.activationId || '').trim();
    if (!INSTANCE_ID_PATTERN.test(instanceId) || !publisherId || !activationId ||
        req.body?.role !== 'obs' || (req.body?.source && req.body.source !== 'obs') || req.body?.handoff !== 'scene') {
        return res.status(400).json({ code: -1, reason: 'invalid-scene-candidate' });
    }
    const result = await withRoomLock(roomId, async () => {
        const candidates = readCandidates(roomId);
        if (!candidates[instanceId] && Object.keys(candidates).length >= MAX_SCENE_CANDIDATES) {
            return { status: 409, body: { code: -1, enabled: true, reason: 'candidate-capacity-exceeded', maxCandidates: MAX_SCENE_CANDIDATES } };
        }
        const now = Date.now();
        const existing = candidates[instanceId] || {};
        const activations = Array.isArray(existing.activations)
            ? existing.activations.filter(item => candidateIsOnline(item))
            : (existing.activationId && candidateIsOnline(existing) ? [existing] : []);
        const index = activations.findIndex(item => item.activationId === activationId);
        const previousActivation = index >= 0 ? activations[index] : null;
        if (index < 0) {
            activations.forEach(item => {
                if (item.activationId !== activationId && !item.supersededAt) {
                    item.supersededAt = now;
                    item.supersededBy = activationId;
                }
            });
        }
        const nextActivation = {
            ...(previousActivation || {}),
            instanceId, publisherId, activationId, role: 'obs', handoff: 'scene', lastSeenAt: now,
            firstSeenAt: Number(previousActivation?.firstSeenAt) || now,
            heartbeatCount: Math.max(0, Number(previousActivation?.heartbeatCount) || 0) + 1,
            heartbeatCountSinceSuperseded: previousActivation?.supersededAt && Number(previousActivation.lastSeenAt) <= Number(previousActivation.supersededAt)
                ? 1
                : Math.max(0, Number(previousActivation?.heartbeatCountSinceSuperseded) || 0) + 1,
            lastHeartbeatSequence: Number(req.body?.heartbeatSequence) || Math.max(0, Number(previousActivation?.lastHeartbeatSequence) || 0) + 1,
            status: 'candidate'
        };
        if (index >= 0) activations[index] = nextActivation;
        else activations.push(nextActivation);
        const latest = activations.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
        const freshActivationCount = activations.filter(item => Date.now() - Number(item.lastSeenAt || 0) <= SYNC_AUTO_TARGET_FRESH_MS).length;
        const conflict = hasConcurrentActivations(activations);
        candidates[instanceId] = {
            ...latest,
            activations,
            conflict,
            reloading: activations.length > 1 && !conflict,
            activationCount: activations.length,
            freshActivationCount
        };
        writeCandidates(roomId, candidates);
        let state = expireHandoff(roomId, readRoomState(roomId));
        const autoSwitch = await evaluateAndRequestAutoSwitchLocked(roomId, state, candidates);
        state = readRoomState(roomId);
        const current = currentPublisherInfo(state);
        const handoff = normalizeHandoff(state);
        const activationRequested = Boolean(handoff && handoff.state === 'target-pending' &&
            handoff.targetInstanceId === instanceId && Date.now() < handoff.deadline &&
            candidateHasActivation(candidates[instanceId], handoff.targetActivationId || candidates[instanceId]?.activationId) &&
            (!candidateIsConflicted(candidates[instanceId]) || handoff.targetActivationId === activationId));
        return {
            status: 200,
            body: {
                code: 0,
                enabled: true,
                data: candidates[instanceId],
                activationRequested,
                switchId: activationRequested ? handoff.switchId : '',
                handoff,
                publisher: current,
                autoSwitch
            }
        };
    });
    res.status(result.status).json(result.body);
});

router.post('/live/sync-candidate-release', async (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    if (!trustedLocalOrigin(req)) return res.status(403).json({ code: -1, reason: 'untrusted-origin' });
    const instanceId = String(req.body?.instanceId || '').trim();
    const activationId = String(req.body?.activationId || '').trim();
    if (!INSTANCE_ID_PATTERN.test(instanceId) || !activationId) return res.status(400).json({ code: -1, reason: 'invalid-scene-candidate' });
    const result = await withRoomLock(roomId, () => {
        const candidates = readCandidates(roomId);
        const candidate = candidates[instanceId];
        if (!candidate) return { removed: false, candidates };
        const activations = (Array.isArray(candidate.activations) ? candidate.activations : [candidate]).filter(item => item.activationId !== activationId);
        if (!activations.length) delete candidates[instanceId];
        else {
            const latest = activations.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
            const conflict = hasConcurrentActivations(activations);
            candidates[instanceId] = { ...latest, activations, conflict, reloading: activations.length > 1 && !conflict, activationCount: activations.length, freshActivationCount: activations.filter(item => Date.now() - Number(item.lastSeenAt || 0) <= SYNC_AUTO_TARGET_FRESH_MS).length };
        }
        writeCandidates(roomId, candidates);
        return { removed: true, candidates };
    });
    res.json({ code: 0, ...result });
});

router.get('/live/sync-candidates', async (req, res) => {
    const roomId = String(req.query.room_id || req.query.roomid || 'default');
    if (!handoffEnabled(roomId)) {
        clearCandidates(roomId);
        sharedAutoSwitchStates.set(roomId, { state: 'disabled', reason: 'scene-handoff-disabled', thresholdMs: 5000, stableRounds: 0 });
        return res.json({ code: 0, enabled: false, data: [], handoff: normalizeHandoff(readRoomState(roomId)), autoSwitch: sharedAutoSwitchStates.get(roomId) });
    }
    const candidates = readCandidates(roomId);
    const state = expireHandoff(roomId, readRoomState(roomId));
    const current = currentPublisherInfo(state);
    const list = Object.values(candidates).filter(candidateIsOnline).map(candidate => ({
        ...candidate,
        isPublisher: candidate.publisherId === current.publisherId && current.status === 'active',
        heartbeatAgeMs: Math.max(0, Date.now() - Number(candidate.lastSeenAt || 0)),
        generation: candidate.publisherId === current.publisherId ? current.generation : 0,
        currentSong: state.currentSong,
        playback: state.playback
    }));
    const autoSwitch = evaluateAutoSwitch(roomId, state, candidates);
    res.json({ code: 0, enabled: true, data: list, handoff: normalizeHandoff(state), publisher: current, autoSwitch });
});

async function requestSceneSwitchLocked(roomId, request = {}) {
        if (!handoffEnabled(roomId)) return { status: 409, body: { code: -1, reason: 'scene-handoff-disabled' } };
        const targetInstanceId = String(request.targetInstanceId || '').trim();
        const targetActivationId = String(request.targetActivationId || '').trim();
        const switchId = String(request.switchId || '').trim();
        if (!INSTANCE_ID_PATTERN.test(targetInstanceId) || !switchId || switchId.length > 200) {
            return { status: 400, body: { code: -1, reason: 'invalid-switch-request' } };
        }
        const state = expireHandoff(roomId, readRoomState(roomId));
        const existing = normalizeHandoff(state);
        if (existing?.switchId === switchId && existing.result) {
            return { status: existing.result.accepted === false ? 409 : 200, body: { code: existing.result.accepted === false ? -1 : 0, data: state, result: existing.result } };
        }
        if (existing && ['revoke-pending', 'target-pending'].includes(existing.state)) {
            return { status: 409, body: { code: -1, data: state, reason: 'switch-in-progress', result: existing } };
        }
        const candidates = readCandidates(roomId);
        const target = candidates[targetInstanceId];
        if (!candidateIsOnline(target) || target.role !== 'obs' || target.handoff !== 'scene') {
            return { status: 409, body: { code: -1, data: state, reason: 'target-candidate-offline' } };
        }
        const selectedActivation = getCandidateActivation(target, targetActivationId);
        if (candidateIsConflicted(target) && (!targetActivationId || !selectedActivation || !candidateIsOnline(selectedActivation))) {
            return { status: 409, body: { code: -1, data: state, reason: 'instance-conflict' } };
        }
        const current = currentPublisherInfo(state);
        const expectedGeneration = Number(request.expectedGeneration);
        const expectedInstanceId = String(request.expectedInstanceId || '');
        if ((Number.isFinite(expectedGeneration) && expectedGeneration !== current.generation) ||
            (expectedInstanceId && expectedInstanceId !== current.instanceId)) {
            return { status: 409, body: { code: -1, data: state, reason: 'switch-conflict' } };
        }
        if (targetInstanceId === current.instanceId) {
            const noop = { accepted: true, switchId, state: 'completed', targetInstanceId, generation: current.generation };
            const persisted = persistRoomState(roomId, { ...state, handoff: { switchId, targetInstanceId, state: 'completed', result: noop, createdAt: Date.now() } });
            return { status: 200, body: { code: 0, data: persisted, result: noop } };
        }
        const now = Date.now();
        const handoff = {
            switchId,
            targetInstanceId,
            targetActivationId: targetActivationId || selectedActivation?.activationId || target.activationId,
            expectedGeneration: current.generation,
            expectedInstanceId: current.instanceId,
            state: 'revoke-pending',
            deadline: now + SYNC_HANDOFF_DEADLINE_MS,
            createdAt: now,
            oldPublisher: current,
            automatic: request.automatic === true,
            result: null
        };
        persistRoomState(roomId, { ...state, handoff });
        if (current.publisherId) {
            appendHandoffCommand(roomId, {
                command: 'revokePublisher',
                switchId,
                targetInstanceId: current.instanceId,
                targetPublisherId: current.publisherId,
                generation: current.generation,
                value: { switchId, generation: current.generation }
            });
        }
        handoff.state = 'target-pending';
        const pending = persistRoomState(roomId, { ...readRoomState(roomId), handoff });
        const accepted = { accepted: true, switchId, state: 'target-pending', targetInstanceId, targetActivationId: handoff.targetActivationId, deadline: handoff.deadline, generation: current.generation + 1 };
        pending.handoff.result = accepted;
        const finalState = persistRoomState(roomId, pending, { bumpRevision: true });
        return { status: 200, body: { code: 0, data: finalState, result: accepted } };
}

async function requestSceneSwitch(roomId, request = {}) {
    return withRoomLock(roomId, () => requestSceneSwitchLocked(roomId, request));
}

router.post('/live/sync-switch', async (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    if (!trustedLocalOrigin(req)) return res.status(403).json({ code: -1, reason: 'untrusted-origin' });
    const result = await requestSceneSwitch(roomId, req.body || {});
    res.status(result.status).json(result.body);
});

router.post('/live/sync-revoke-ack', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    if (!trustedLocalOrigin(req)) return res.status(403).json({ code: -1, reason: 'untrusted-origin' });
    if (!handoffEnabled(roomId)) return res.status(409).json({ code: -1, reason: 'scene-handoff-disabled' });
    const state = readRoomState(roomId);
    const handoff = normalizeHandoff(state);
    const publisher = currentPublisherInfo(state);
    const switchId = String(req.body?.switchId || '');
    const generation = Number(req.body?.generation);
    const oldPublisher = handoff?.oldPublisher || {};
    const valid = handoff?.switchId === switchId &&
        String(req.body?.publisherId || '') === String(oldPublisher.publisherId || publisher.publisherId) &&
        generation === Number(oldPublisher.generation ?? publisher.generation);
    if (!valid) return res.status(409).json({ code: -1, data: state, reason: 'stale-publisher' });
    const nextHandoff = { ...handoff, revokeAckAt: Date.now() };
    const isStillOldPublisher = publisher.publisherId === oldPublisher.publisherId && publisher.generation === oldPublisher.generation;
    const nextState = isStillOldPublisher && req.body?.playback && typeof req.body.playback === 'object'
        ? { ...state, playback: req.body.playback, handoff: nextHandoff }
        : { ...state, handoff: nextHandoff };
    const persisted = persistRoomState(roomId, nextState);
    res.json({ code: 0, data: persisted, acknowledged: true });
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
    const instanceId = String(req.body?.instanceId || '');
    const switchId = String(req.body?.switchId || '');
    const activationId = String(req.body?.activationId || '');
    if (!publisherId) {
        return res.status(400).json({ code: -1, message: 'publisherId必须存在' });
    }
    if (switchId && !handoffEnabled(roomId)) {
        return res.json({ code: 0, claimed: false, ignored: true, reason: 'scene-handoff-disabled' });
    }

    const current = readRoomState(roomId);
    const currentPublisher = currentPublisherInfo(current);
    const currentPublisherId = currentPublisher.publisherId;
    const publisherLeaseActive = current && currentPublisherId && currentPublisher.status === 'active' &&
        Date.now() - currentPublisher.heartbeatAt < SYNC_PUBLISHER_LEASE_MS;

    const handoff = normalizeHandoff(current);
    const candidates = handoffEnabled(roomId) ? readCandidates(roomId) : {};
    const candidate = candidates[instanceId];
    const targetActivation = getCandidateActivation(candidate, handoff?.targetActivationId || activationId);
    const targetClaimAllowed = Boolean(handoff && handoff.state === 'target-pending' &&
        switchId && handoff.switchId === switchId && handoff.targetInstanceId === instanceId &&
        Date.now() < handoff.deadline && candidateIsOnline(candidate) &&
        (!candidateIsConflicted(candidate) || handoff.targetActivationId === activationId) &&
        targetActivation?.publisherId === publisherId && candidateHasActivation(candidate, handoff.targetActivationId || activationId));
    if (switchId) console.info('[AUTO_CLAIM_ATTEMPT]', { roomId, switchId, targetInstanceId: instanceId, targetActivationId: activationId, handoffState: handoff?.state || 'none' });
    if (switchId && !targetClaimAllowed) {
        console.warn('[AUTO_CLAIM_REJECTED]', { roomId, switchId, targetInstanceId: instanceId, targetActivationId: activationId, reason: 'handoff-target-mismatch', handoffState: handoff?.state || 'none' });
        return res.json({ code: 0, data: current, claimed: false, ignored: true, reason: 'handoff-target-mismatch' });
    }

    if (publisherLeaseActive && currentPublisherId !== publisherId && !targetClaimAllowed) {
        return res.json({ code: 0, data: current, claimed: false, ignored: true, reason: 'publisher-locked' });
    }

    const now = Date.now();
    const sameActivePublisher = publisherLeaseActive && currentPublisherId === publisherId && !targetClaimAllowed;
    const supplied = requestPublisherInfo(req.body);
    if (sameActivePublisher && supplied.generation != null && supplied.generation !== currentPublisher.generation) {
        return res.json({ code: 0, data: current, claimed: false, ignored: true, reason: 'stale-publisher' });
    }
    if (sameActivePublisher && supplied.leaseToken && supplied.leaseToken !== currentPublisher.leaseToken) {
        return res.json({ code: 0, data: current, claimed: false, ignored: true, reason: 'fenced' });
    }
    if (sameActivePublisher && supplied.generation == null && !supplied.leaseToken) {
        return res.json({ code: 0, data: current, claimed: false, ignored: true, reason: 'publisher-locked' });
    }
    const generation = sameActivePublisher ? currentPublisher.generation : currentPublisher.generation + 1;
    const leaseToken = sameActivePublisher && supplied.leaseToken === currentPublisher.leaseToken
        ? currentPublisher.leaseToken
        : createLeaseToken();
    const nextState = {
        ...current,
        publisherId,
        publisherInstanceId: instanceId,
        publisherGeneration: generation,
        publisherLeaseToken: leaseToken,
        publisher: {
            publisherId,
            instanceId,
            generation,
            leaseToken,
            status: 'active',
            heartbeatAt: now
        },
        stateRevision: (Number(current.stateRevision) || 0) + 1,
        publisherStartedAt: sameActivePublisher
            ? Number(current.publisherStartedAt) || now
            : now,
        publisherHeartbeatAt: now,
        updatedAt: now,
        handoff: targetClaimAllowed
            ? {
                ...handoff,
                state: 'completed',
                result: { accepted: true, switchId, state: 'completed', targetInstanceId: instanceId, generation }
            }
            : current.handoff
    };
    if (targetClaimAllowed && handoff?.automatic) {
        const completedAt = Date.now();
        const previous = sharedAutoSwitchStates.get(roomId) || {};
        sharedAutoSwitchStates.set(roomId, { ...previous, state: 'completed', reason: 'target-claimed', switchId, targetInstanceId: instanceId, targetActivationId: activationId, generation, completedAt });
        console.info('[AUTO_CLAIM_COMPLETED]', { roomId, switchId, targetInstanceId: instanceId, targetActivationId: activationId, generation, handoffState: 'completed' });
    }
    writeSyncFile(syncFilePath('state', roomId), nextState);
    sharedOrderStates.set(roomId, nextState);
    res.json({ code: 0, data: nextState, claimed: true, generation, leaseToken, switchId: targetClaimAllowed ? switchId : '' });
});

router.post('/live/sync-state', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const state = req.body?.state;
    if (!state || typeof state !== 'object') {
        return res.status(400).json({ code: -1, message: 'state必须是对象' });
    }
    const current = readRoomState(roomId);
    const incomingPublisherId = String(state.publisherId || '');
    const currentPublisher = currentPublisherInfo(current);
    const currentPublisherId = currentPublisher.publisherId;
    const publisherLeaseActive = currentPublisherId && currentPublisher.status === 'active' &&
        Date.now() - currentPublisher.heartbeatAt < SYNC_PUBLISHER_LEASE_MS;
    const auth = publisherAuthResult(current, requestPublisherInfo(state));

    // 一个房间只允许当前 OBS 播放页发布状态，避免旧 OBS 页或另一个普通播放页
    // 在切歌期间把控制页覆盖回另一首歌。发布者停止心跳后，新的页面才能接管。
    if (publisherLeaseActive && incomingPublisherId !== currentPublisherId) {
        return res.json({ code: 0, data: current, ignored: true, reason: 'publisher-locked' });
    }
    if (publisherLeaseActive && currentPublisherId && !incomingPublisherId) {
        return res.json({ code: 0, data: current, ignored: true, reason: 'publisher-required' });
    }
    if (incomingPublisherId && !auth.ok && ['stale-publisher', 'fenced', 'publisher-expired', 'publisher-released'].includes(auth.reason)) {
        return res.status(409).json({ code: -1, data: current, ignored: true, reason: auth.reason });
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
        publisherInstanceId: String(state.publisherInstanceId || state.publisher?.instanceId || canonical.publisherInstanceId || ''),
        publisherGeneration: Number(state.publisherGeneration ?? state.publisher?.generation ?? canonical.publisherGeneration) || 0,
        publisherLeaseToken: String(state.publisherLeaseToken || state.publisher?.leaseToken || canonical.publisherLeaseToken || ''),
        publisher: {
            ...(canonical.publisher || {}),
            publisherId: incomingPublisherId || (publisherLeaseActive ? currentPublisherId : canonical.publisherId),
            instanceId: String(state.publisherInstanceId || state.publisher?.instanceId || canonical.publisherInstanceId || ''),
            generation: Number(state.publisherGeneration ?? state.publisher?.generation ?? canonical.publisherGeneration) || 0,
            leaseToken: String(state.publisherLeaseToken || state.publisher?.leaseToken || canonical.publisherLeaseToken || ''),
            status: 'active',
            heartbeatAt: Date.now()
        },
        publisherStartedAt: Number(state.publisherStartedAt) || canonical.publisherStartedAt || Date.now(),
        publisherHeartbeatAt: Date.now()
    };
    if (nextState.settings.login?.songListId && !nextState.songListId) {
        nextState.songListId = String(nextState.settings.login.songListId);
    }
    const persisted = persistRoomState(roomId, nextState);
    res.json({ code: 0, data: persisted });
});

// 场景隐藏/页面卸载时主动交出播放端，保留歌曲、队列和歌词引用。
router.post('/live/sync-release', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const current = readRoomState(roomId);
    const auth = publisherAuthResult(current, requestPublisherInfo(req.body), { allowLegacy: false });
    if (!auth.ok) return res.status(409).json({ code: -1, data: current, released: false, reason: auth.reason });
    const playback = req.body?.playback && typeof req.body.playback === 'object'
        ? { ...current.playback, ...req.body.playback }
        : current.playback;
    const now = Date.now();
    const next = {
        ...current,
        playback,
        publisher: { ...currentPublisherInfo(current), status: 'released', heartbeatAt: now },
        publisherHeartbeatAt: now,
        updatedAt: now,
        handoff: current.handoff
    };
    const persisted = persistRoomState(roomId, next);
    res.json({ code: 0, data: persisted, released: true });
});

router.get('/live/sync-lyrics', (req, res) => {
    const roomId = String(req.query.room_id || req.query.roomid || 'default');
    const key = String(req.query.song_key || req.query.songKey || '').trim();
    if (!key) return res.status(400).json({ code: -1, message: 'song_key必须存在' });
    const snapshot = readLyricsSnapshot(roomId, key);
    res.json({ code: 0, data: snapshot });
});

router.post('/live/sync-lyrics', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    const key = String(req.body?.songKey || req.body?.song_key || '').trim();
    if (!key) return res.status(400).json({ code: -1, message: 'songKey必须存在' });
    const current = readRoomState(roomId);
    const auth = publisherAuthResult(current, requestPublisherInfo(req.body), { allowLegacy: false });
    if (!auth.ok) return res.status(409).json({ code: -1, data: current, reason: auth.reason });
    const lyrics = normalizeLyricsPayload(req.body?.lyrics);
    const canonical = JSON.stringify(lyrics);
    const contentHash = crypto.createHash('sha256').update(canonical).digest('hex');
    const previous = readLyricsSnapshot(roomId, key);
    const revision = previous && previous.contentHash === contentHash
        ? Number(previous.revision) || 1
        : (Number(previous?.revision) || 0) + 1;
    const snapshot = { roomId, songKey: key, lyrics, contentHash, revision, updatedAt: Date.now() };
    writeSyncFile(lyricsFilePath(roomId, key), snapshot);
    sharedLyricsSnapshots.set(`${roomId}:${key}`, snapshot);
    const next = {
        ...current,
        lyrics: { songKey: key, status: lyrics.noLyrics ? 'empty' : 'ready', revision, contentHash, updatedAt: snapshot.updatedAt }
    };
    const persisted = persistRoomState(roomId, next);
    res.json({ code: 0, data: snapshot, state: persisted });
});

router.post('/live/sync-command', (req, res) => {
    const roomId = String(req.body?.room_id || req.body?.roomid || 'default');
    if (!trustedLocalOrigin(req)) return res.status(403).json({ code: -1, reason: 'untrusted-origin' });
    const command = req.body?.command;
    if (!command || typeof command !== 'object') {
        return res.status(400).json({ code: -1, message: 'command必须是对象' });
    }
    const current = readRoomState(roomId);
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
    const commandId = String(command.id || '').trim();
    if (commandId) {
        const duplicate = list.find(item => String(item.id || '') === commandId);
        if (duplicate) {
            const state = readRoomState(roomId);
            return res.status(duplicate.result?.accepted === false ? (Number(duplicate.result.httpStatus) || 409) : 200).json({
                code: duplicate.result?.accepted === false ? -1 : 0,
                data: state,
                result: { ...(duplicate.result || {}), duplicate: true }
            });
        }
    }
    const lastSequence = list.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0);
    const nextCommand = {
        ...command,
        publisherId: command.publisherId || req.body?.publisherId || '',
        generation: command.generation ?? req.body?.generation,
        leaseToken: command.leaseToken || req.body?.leaseToken || '',
        sequence: Math.max(sharedOrderCommandSeq, lastSequence) + 1,
        createdAt: Date.now()
    };
    const applied = applyRoomCommand(roomId, nextCommand);
    const canonicalState = applied.state;
    const publisher = currentPublisherInfo(canonicalState);
    const publisherOnline = Boolean(publisher.publisherId && publisher.status === 'active' &&
        Date.now() - publisher.heartbeatAt < SYNC_PUBLISHER_LEASE_MS);
    if (applied.result.accepted !== false) {
        applied.result.delivery = publisherOnline ? 'queued' : 'pending';
    }
    if (nextCommand.command === 'addOrder') {
        const order = nextCommand.value || {};
        console.log('[OrderSong][addOrder]', {
            roomId,
            uid: order.uid || 0,
            uname: order.uname || '',
            song: order.song?.sname || '',
            sid: order.song?.sid || '',
            accepted: applied.result.accepted !== false,
            reason: applied.result.reason || '',
            delivery: applied.result.delivery || '',
            queueLength: canonicalState.queue?.length || 0,
            currentSong: canonicalState.currentSong?.sname || ''
        });
    }
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

// 普通直播间弹幕鉴权，不依赖B站开放平台许可
router.get('/live/danmu-info', async (req, res) => {
    const roomId = Number(req.query.room_id || req.query.roomid);
    if (!Number.isInteger(roomId) || roomId <= 0) return res.status(400).json({ code: -1, message: 'room_id必须是正整数' });
    try {
        const session = getBiliSession();
        const info = await session.getDanmuInfo(roomId);
        res.json({
            code: 0,
            message: '0',
            data: {
                _room_id: info.roomId,
                host_list: info.raw.host_list,
                session: session.diagnostics()
            }
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
        const history = await getBiliSession().getHistory(roomId);
        const items = Array.isArray(history.raw?.data?.room) ? history.raw.data.room : [];
        const signature = items.map(item => item.id_str || [item.uid, item.timeline, item.text].join('|')).join('||');
        const previous = historyDiagnostics.get(roomId);
        if (!previous || previous.signature !== signature) {
            historyDiagnostics.set(roomId, { signature, loggedAt: Date.now() });
            console.log('[BilibiliDanmu][history] 历史10条模式更新', {
                roomId,
                resolvedRoomId: history.roomId,
                count: items.length,
                messages: items.map(item => ({
                    uid: item.uid || item.user?.uid || 0,
                    uname: item.user?.base?.name || item.uname || item.nickname || '用户',
                    danmu: item.text || ''
                }))
            });
        }
        res.json({
            ...history.raw,
            data: { ...history.raw.data, _room_id: history.roomId }
        });
    } catch (error) {
        console.error('获取B站历史弹幕失败:', error.response?.data || error.message);
        res.status(502).json({ code: -1, message: '获取B站历史弹幕失败', detail: error.message });
    }
});

// 只返回无敏感信息的连接汇总，用于确认漏消息发生在上游、解析还是浏览器转发层。
router.get('/live/metrics', (req, res) => {
    const roomId = Number(req.query.room_id || req.query.roomid);
    if (!Number.isInteger(roomId) || roomId <= 0) return res.status(400).json({ code: -1, message: 'room_id必须是正整数' });
    const metrics = getAttachedLiveDanmuHub()?.metricsFor(roomId);
    if (!metrics) return res.status(404).json({ code: -1, message: '该房间当前没有实时弹幕连接' });
    res.json({ code: 0, data: metrics });
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
