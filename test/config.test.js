const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePort, loadRuntimeConfig } = require('../src/config');
const { LocalStore, mergeSettings } = require('../src/services/local-store');

test('uses default port when values are missing', () => {
    assert.strictEqual(resolvePort(undefined), 8000);
});

test('accepts a YAML-configured port', () => {
    assert.strictEqual(resolvePort('9123'), 9123);
});

test('runtime config gives DAMUKU_PORT precedence over YAML', () => {
    const previous = process.env.DAMUKU_PORT;
    process.env.DAMUKU_PORT = '19001';
    try {
        assert.strictEqual(loadRuntimeConfig(process.cwd()).port, 19001);
    } finally {
        if (previous === undefined) delete process.env.DAMUKU_PORT;
        else process.env.DAMUKU_PORT = previous;
    }
});

test('rejects invalid ports before listen()', () => {
    for (const value of [0, 65536, 'abc', 1.5]) {
        assert.throws(() => resolvePort(value), /1-65535/);
    }
});

test('local store keeps validated settings and credentials separate', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'damuku-store-'));
    try {
        const store = new LocalStore(tempRoot);
        const saved = store.updateSettings('room-1', {
            order: { globalMaxOrder: 2, overLimitSkip: 30 },
            login: { platform: 'wy', songListId: 'list-1' }
        });
        assert.strictEqual(saved.ok, true);
        assert.strictEqual(store.getSettings('room-1').order.globalMaxOrder, 2);
        assert.strictEqual(store.getSettings('room-1').login.songListId, 'list-1');
        assert.strictEqual(store.saveNeteaseCookie('MUSIC_U=secret'), true);
        assert.strictEqual(store.hasNeteaseCookie(), true);
        assert.strictEqual(fs.existsSync(store.credentialPath()), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('multi-scene auto settings default safely and clamp the heartbeat threshold', () => {
    const defaults = mergeSettings().display;
    assert.strictEqual(defaults.multiSceneHandoffEnabled, false);
    assert.strictEqual(defaults.multiSceneAutoSwitchEnabled, false);
    assert.strictEqual(defaults.multiSceneHeartbeatThresholdMs, 5000);
    const clamped = mergeSettings({ display: {
        multiSceneHandoffEnabled: true,
        multiSceneAutoSwitchEnabled: true,
        multiSceneHeartbeatThresholdMs: 99999
    } }).display;
    assert.strictEqual(clamped.multiSceneAutoSwitchEnabled, true);
    assert.strictEqual(clamped.multiSceneHeartbeatThresholdMs, 8000);
    const disabled = mergeSettings({ display: {
        multiSceneHandoffEnabled: false,
        multiSceneAutoSwitchEnabled: true
    } }).display;
    assert.strictEqual(disabled.multiSceneAutoSwitchEnabled, false);
});
