const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const router = require('../src/routers/bili-router');
const { LocalStore } = require('../src/services/local-store');

async function withServer(callback) {
    const app = express();
    app.use(express.json());
    app.use('/order/bili-api', router);
    const server = await new Promise(resolve => {
        const value = app.listen(0, () => resolve(value));
    });
    try {
        return await callback(`http://127.0.0.1:${server.address().port}/order/bili-api`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function syncFile(prefix, roomId) {
    return path.resolve(__dirname, '..', 'cache', 'order-sync', `${prefix}-${roomId}.json`);
}

test('publisher claim fences stale state, releases, and transfers generation', async () => {
    const roomId = `test-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const store = new LocalStore(path.resolve(__dirname, '..'));
    const originalEnabled = store.getSettings(null).display.multiSceneHandoffEnabled;
    store.updateSettings(null, { display: { multiSceneHandoffEnabled: false } }, null);
    try {
        await withServer(async base => {
            const post = (url, body) => fetch(`${base}${url}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            }).then(async response => ({ response, body: await response.json() }));
            const disabledCandidate = await post('/live/sync-candidate', {
                room_id: roomId,
                publisherId: 'publisher-a',
                activationId: 'activation-a',
                instanceId: 'scene-a',
                role: 'obs',
                handoff: 'scene'
            });
            assert.equal(disabledCandidate.body.reason, 'scene-handoff-disabled');
            const disabledSwitch = await post('/live/sync-switch', {
                room_id: roomId,
                targetInstanceId: 'scene-a',
                switchId: 'disabled-switch'
            });
            assert.equal(disabledSwitch.body.reason, 'scene-handoff-disabled');
            const first = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-a', instanceId: 'scene-a' });
            assert.equal(first.body.claimed, true);
            assert.ok(first.body.leaseToken);
            const locked = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-b', instanceId: 'scene-b' });
            assert.equal(locked.body.claimed, false);
            assert.equal(locked.body.reason, 'publisher-locked');
            const stale = await post('/live/sync-state', {
                room_id: roomId,
                state: {
                    publisherId: 'publisher-a',
                    publisherGeneration: first.body.generation - 1,
                    publisherLeaseToken: 'stale-token',
                    playback: { songKey: '', paused: true }
                }
            });
            assert.equal(stale.response.status, 409);
            assert.equal(stale.body.reason, 'stale-publisher');
            const released = await post('/live/sync-release', {
                room_id: roomId,
                publisherId: 'publisher-a',
                generation: first.body.generation,
                leaseToken: first.body.leaseToken,
                playback: { songKey: '', positionMs: 1234, paused: true, sampledAt: Date.now() }
            });
            assert.equal(released.body.released, true);
            const late = await post('/live/sync-state', {
                room_id: roomId,
                state: {
                    publisherId: 'publisher-a',
                    publisherGeneration: first.body.generation,
                    publisherLeaseToken: first.body.leaseToken,
                    playback: { songKey: '', positionMs: 9999, paused: false }
                }
            });
            assert.equal(late.response.status, 409);
            assert.equal(late.body.reason, 'publisher-released');
            const second = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-b', instanceId: 'scene-b' });
            assert.equal(second.body.claimed, true);
            assert.equal(second.body.generation, first.body.generation + 1);
            assert.notEqual(second.body.leaseToken, first.body.leaseToken);
        });
    } finally {
        try { fs.unlinkSync(syncFile('state', roomId)); } catch (_) { }
        store.updateSettings(null, { display: { multiSceneHandoffEnabled: originalEnabled } }, null);
    }
});

test('lyrics snapshots are versioned and readable by mirror pages', async () => {
    const roomId = `test-lyrics-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const songKey = 'wy:sync-test';
    try {
        await withServer(async base => {
            const post = (url, body) => fetch(`${base}${url}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            }).then(response => response.json());
            const claim = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher', instanceId: 'scene' });
            const saved = await post('/live/sync-lyrics', {
                room_id: roomId,
                publisherId: 'publisher',
                generation: claim.generation,
                leaseToken: claim.leaseToken,
                songKey,
                lyrics: { original: [{ startMs: 100, text: 'hello' }], parserVersion: 1 }
            });
            assert.equal(saved.code, 0);
            assert.equal(saved.data.revision, 1);
            const response = await fetch(`${base}/live/sync-lyrics?room_id=${roomId}&song_key=${encodeURIComponent(songKey)}`);
            const read = await response.json();
            assert.equal(read.data.contentHash, saved.data.contentHash);
            assert.equal(read.data.lyrics.original[0].text, 'hello');
        });
    } finally {
        try { fs.unlinkSync(syncFile('state', roomId)); } catch (_) { }
        try { fs.unlinkSync(path.resolve(__dirname, '..', 'cache', 'order-sync', `lyrics-${roomId}-wy_sync-test.json`)); } catch (_) { }
    }
});

test('control commands remain accepted when the old publisher lease is expired', async () => {
    const roomId = `test-command-expired-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
        await withServer(async base => {
            const response = await fetch(`${base}/live/sync-command`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    room_id: roomId,
                    publisherId: 'expired-publisher',
                    generation: 9,
                    leaseToken: 'expired-token',
                    command: {
                        id: 'expired-load-song-list',
                        command: 'loadSongList',
                        value: {
                            requestId: String(Date.now()),
                            platform: 'wy',
                            listId: 'expired-list',
                            songList: [{ sid: 'expired-song', sname: 'expired command song', sartist: 'test' }]
                        }
                    }
                })
            });
            const body = await response.json();
            assert.equal(response.status, 200);
            assert.equal(body.code, 0);
            assert.equal(body.result.accepted, true);
            assert.equal(body.result.delivery, 'pending');
        });
    } finally {
        try { fs.unlinkSync(syncFile('state', roomId)); } catch (_) { }
        try { fs.unlinkSync(path.resolve(__dirname, '..', 'cache', 'order-sync', `commands-${roomId}.jsonl`)); } catch (_) { }
    }
});

test('manual scene handoff exposes candidates and only the selected instance can claim', async () => {
    const roomId = `test-handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const store = new LocalStore(path.resolve(__dirname, '..'));
    const originalEnabled = store.getSettings(null).display.multiSceneHandoffEnabled;
    try {
        await withServer(async base => {
            const request = (url, options = {}) => fetch(`${base}${url}`, options).then(async response => ({ response, body: await response.json() }));
            const post = (url, body) => request(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            await request('/live/settings', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, settings: { display: { multiSceneHandoffEnabled: true } } })
            });
            const first = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-a', instanceId: 'scene-a' });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-a', activationId: 'activation-a', instanceId: 'scene-a', role: 'obs', handoff: 'scene' });
            const candidate = await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-b', activationId: 'activation-b', instanceId: 'scene-b', role: 'obs', handoff: 'scene' });
            assert.equal(candidate.body.enabled, true);
            const switched = await post('/live/sync-switch', {
                room_id: roomId,
                targetInstanceId: 'scene-b',
                switchId: 'switch-1',
                expectedGeneration: first.body.generation,
                expectedInstanceId: 'scene-a'
            });
            assert.equal(switched.body.result.state, 'target-pending');
            const wrong = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-c', activationId: 'activation-c', instanceId: 'scene-c', switchId: 'switch-1' });
            assert.equal(wrong.body.reason, 'handoff-target-mismatch');
            const target = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-b', activationId: 'activation-b', instanceId: 'scene-b', switchId: 'switch-1' });
            assert.equal(target.body.claimed, true);
            assert.equal(target.body.generation, first.body.generation + 1);
            const duplicate = await post('/live/sync-switch', {
                room_id: roomId,
                targetInstanceId: 'scene-b',
                switchId: 'switch-1',
                expectedGeneration: first.body.generation,
                expectedInstanceId: 'scene-a'
            });
            assert.equal(duplicate.body.result.state, 'completed');
        });
    } finally {
        // The test toggles a global setting; restore the previous value for subsequent runs.
        store.updateSettings(null, { display: { multiSceneHandoffEnabled: originalEnabled } }, null);
        for (const prefix of ['state', 'candidates']) {
            try { fs.unlinkSync(syncFile(prefix, roomId)); } catch (_) { }
        }
    }
});

test('manual handoff can explicitly select the requested activation of a duplicate instance', async () => {
    const roomId = `test-handoff-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const store = new LocalStore(path.resolve(__dirname, '..'));
    const original = store.getSettings(null).display;
    try {
        await withServer(async base => {
            const post = (url, body) => fetch(`${base}${url}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            }).then(async response => ({ response, body: await response.json() }));
            await fetch(`${base}/live/settings`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, settings: { display: { multiSceneHandoffEnabled: true, multiSceneAutoSwitchEnabled: false } } })
            });
            const current = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-current', instanceId: 'scene-a' });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-b1', activationId: 'activation-b1', instanceId: 'scene-b', role: 'obs', source: 'obs', handoff: 'scene' });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-b2', activationId: 'activation-b2', instanceId: 'scene-b', role: 'obs', source: 'obs', handoff: 'scene' });
            const switched = await post('/live/sync-switch', {
                room_id: roomId,
                targetInstanceId: 'scene-b',
                targetActivationId: 'activation-b1',
                switchId: 'conflict-switch',
                expectedGeneration: current.body.generation,
                expectedInstanceId: 'scene-a'
            });
            assert.equal(switched.body.result.state, 'target-pending');
            const claimed = await post('/live/sync-claim', {
                room_id: roomId,
                publisherId: 'publisher-b1',
                activationId: 'activation-b1',
                instanceId: 'scene-b',
                switchId: 'conflict-switch'
            });
            assert.equal(claimed.body.claimed, true);
        });
    } finally {
        store.updateSettings(null, { display: original }, null);
        for (const prefix of ['state', 'candidates']) {
            try { fs.unlinkSync(syncFile(prefix, roomId)); } catch (_) { }
        }
    }
});

test('auto handoff selects the only fresh target after the current publisher releases', async () => {
    const roomId = `test-handoff-auto-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const store = new LocalStore(path.resolve(__dirname, '..'));
    const original = store.getSettings(null).display;
    try {
        await withServer(async base => {
            const post = (url, body) => fetch(`${base}${url}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            }).then(async response => ({ response, body: await response.json() }));
            const get = url => fetch(`${base}${url}`).then(response => response.json());
            await fetch(`${base}/live/settings`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, settings: { display: { multiSceneHandoffEnabled: true, multiSceneAutoSwitchEnabled: true, multiSceneHeartbeatThresholdMs: 5000 } } })
            });
            const current = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-auto-a', instanceId: 'scene-a' });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-auto-a', activationId: 'activation-auto-a', instanceId: 'scene-a', role: 'obs', source: 'obs', handoff: 'scene' });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-auto-b', activationId: 'activation-auto-b', instanceId: 'scene-b', role: 'obs', source: 'obs', handoff: 'scene' });
            await post('/live/sync-release', {
                room_id: roomId,
                publisherId: 'publisher-auto-a',
                generation: current.body.generation,
                leaseToken: current.body.leaseToken,
                playback: { songKey: '', paused: true, sampledAt: Date.now() }
            });
            await new Promise(resolve => setTimeout(resolve, 1100));
            const first = await get(`/live/sync-candidates?room_id=${encodeURIComponent(roomId)}`);
            await new Promise(resolve => setTimeout(resolve, 1100));
            const second = await get(`/live/sync-candidates?room_id=${encodeURIComponent(roomId)}`);
            assert.equal(first.autoSwitch.state, 'waiting');
            assert.equal(second.autoSwitch.state, 'switching');
            assert.equal(second.autoSwitch.targetInstanceId, 'scene-b');
        });
    } finally {
        store.updateSettings(null, { display: original }, null);
        for (const prefix of ['state', 'candidates']) {
            try { fs.unlinkSync(syncFile(prefix, roomId)); } catch (_) { }
        }
    }
});

test('a completed historical handoff does not block auto takeover after publisher timeout', async () => {
    const roomId = `test-handoff-auto-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const store = new LocalStore(path.resolve(__dirname, '..'));
    const original = store.getSettings(null).display;
    try {
        await withServer(async base => {
            const post = (url, body) => fetch(`${base}${url}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            }).then(async response => ({ response, body: await response.json() }));
            const get = url => fetch(`${base}${url}`).then(response => response.json());
            await fetch(`${base}/live/settings`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, settings: { display: { multiSceneHandoffEnabled: true, multiSceneAutoSwitchEnabled: true } } })
            });
            const current = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-timeout-a', instanceId: 'scene-a' });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-timeout-a', activationId: 'activation-timeout-a', instanceId: 'scene-a', role: 'obs', source: 'obs', handoff: 'scene' });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-timeout-b', activationId: 'activation-timeout-b', instanceId: 'scene-b', role: 'obs', source: 'obs', handoff: 'scene' });
            const completed = await post('/live/sync-switch', {
                room_id: roomId,
                targetInstanceId: 'scene-a',
                switchId: 'historical-noop',
                expectedGeneration: current.body.generation,
                expectedInstanceId: 'scene-a'
            });
            assert.equal(completed.body.result.state, 'completed');
            const statePath = syncFile('state', roomId);
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            state.publisher.heartbeatAt = Date.now() - 6000;
            state.publisherHeartbeatAt = state.publisher.heartbeatAt;
            fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
            await new Promise(resolve => setTimeout(resolve, 1100));
            await get(`/live/sync-candidates?room_id=${encodeURIComponent(roomId)}`);
            await new Promise(resolve => setTimeout(resolve, 1100));
            const latest = await get(`/live/sync-candidates?room_id=${encodeURIComponent(roomId)}`);
            assert.equal(latest.autoSwitch.state, 'switching');
            assert.equal(latest.autoSwitch.targetInstanceId, 'scene-b');
        });
    } finally {
        store.updateSettings(null, { display: original }, null);
        for (const prefix of ['state', 'candidates']) {
            try { fs.unlinkSync(syncFile(prefix, roomId)); } catch (_) { }
        }
    }
});

test('candidate reloads are not conflicts, while sustained duplicate activations are', async () => {
    const roomId = `test-candidate-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const store = new LocalStore(path.resolve(__dirname, '..'));
    const original = store.getSettings(null).display;
    try {
        await withServer(async base => {
            const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(response => response.json());
            const get = url => fetch(`${base}${url}`).then(response => response.json());
            await fetch(`${base}/live/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room_id: roomId, settings: { display: { multiSceneHandoffEnabled: true } } }) });
            const baseCandidate = { room_id: roomId, instanceId: 'scene-reload', role: 'obs', source: 'obs', handoff: 'scene' };
            await post('/live/sync-candidate', { ...baseCandidate, publisherId: 'publisher-old', activationId: 'activation-old' });
            await post('/live/sync-candidate', { ...baseCandidate, publisherId: 'publisher-old', activationId: 'activation-old' });
            await post('/live/sync-candidate', { ...baseCandidate, publisherId: 'publisher-new', activationId: 'activation-new' });
            let candidates = await get(`/live/sync-candidates?room_id=${encodeURIComponent(roomId)}`);
            assert.equal(candidates.data[0].conflict, false);
            await post('/live/sync-candidate-release', { room_id: roomId, instanceId: 'scene-reload', activationId: 'activation-old' });
            candidates = await get(`/live/sync-candidates?room_id=${encodeURIComponent(roomId)}`);
            assert.equal(candidates.data[0].activationCount, 1);
            await post('/live/sync-candidate', { ...baseCandidate, publisherId: 'publisher-old', activationId: 'activation-old' });
            await post('/live/sync-candidate', { ...baseCandidate, publisherId: 'publisher-new', activationId: 'activation-new' });
            await post('/live/sync-candidate', { ...baseCandidate, publisherId: 'publisher-old', activationId: 'activation-old' });
            await post('/live/sync-candidate', { ...baseCandidate, publisherId: 'publisher-new', activationId: 'activation-new' });
            candidates = await get(`/live/sync-candidates?room_id=${encodeURIComponent(roomId)}`);
            assert.equal(candidates.data[0].conflict, true);
        });
    } finally {
        store.updateSettings(null, { display: original }, null);
        for (const prefix of ['state', 'candidates']) try { fs.unlinkSync(syncFile(prefix, roomId)); } catch (_) { }
    }
});

test('candidate heartbeat drives automatic handoff without a control page', async () => {
    const roomId = `test-auto-heartbeat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const store = new LocalStore(path.resolve(__dirname, '..'));
    const original = store.getSettings(null).display;
    try {
        await withServer(async base => {
            const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(response => response.json());
            await fetch(`${base}/live/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room_id: roomId, settings: { display: { multiSceneHandoffEnabled: true, multiSceneAutoSwitchEnabled: true } } }) });
            const current = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-a', instanceId: 'scene-a' });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-a', activationId: 'activation-a', instanceId: 'scene-a', role: 'obs', source: 'obs', handoff: 'scene' });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-b', activationId: 'activation-b', instanceId: 'scene-b', role: 'obs', source: 'obs', handoff: 'scene' });
            await post('/live/sync-release', { room_id: roomId, publisherId: 'publisher-a', generation: current.generation, leaseToken: current.leaseToken });
            await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-b', activationId: 'activation-b', instanceId: 'scene-b', role: 'obs', source: 'obs', handoff: 'scene' });
            const heartbeat = await post('/live/sync-candidate', { room_id: roomId, publisherId: 'publisher-b', activationId: 'activation-b', instanceId: 'scene-b', role: 'obs', source: 'obs', handoff: 'scene' });
            assert.equal(heartbeat.activationRequested, true);
            assert.equal(heartbeat.handoff.state, 'target-pending');
            const claimed = await post('/live/sync-claim', { room_id: roomId, publisherId: 'publisher-b', activationId: 'activation-b', instanceId: 'scene-b', switchId: heartbeat.switchId });
            assert.equal(claimed.claimed, true);
            assert.equal(claimed.data.handoff.state, 'completed');
        });
    } finally {
        store.updateSettings(null, { display: original }, null);
        for (const prefix of ['state', 'candidates']) try { fs.unlinkSync(syncFile(prefix, roomId)); } catch (_) { }
    }
});
