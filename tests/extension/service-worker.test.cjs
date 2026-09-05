'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceDir = path.resolve(__dirname, '../../src/chrome-extension');

function createWorker(overrides = {}) {
    const values = { enabled: true, allowedOrigins: ['https://emby.moear.de'], ...overrides };
    const nativeRequests = [];
    const registrations = [];
    let handleMessage;
    let context;
    const event = () => ({ addListener() {} });
    const chrome = {
        runtime: {
            id: 'bridge-extension',
            onInstalled: event(), onStartup: event(),
            onMessage: { addListener(listener) { handleMessage = listener; } },
            connectNative() {
                let listener;
                return {
                    onMessage: { addListener(fn) { listener = fn; } },
                    onDisconnect: event(),
                    disconnect() {},
                    postMessage(payload) {
                        nativeRequests.push(payload);
                        queueMicrotask(() => listener({ ok: true, count: payload.items.length }));
                    },
                };
            },
        },
        storage: {
            local: {
                get(_keys, callback) { queueMicrotask(() => callback({ ...values })); },
                async set() { throw new Error('一次性播放不得修改默认设置'); },
            },
            onChanged: event(),
        },
        action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
        tabs: { async sendMessage() {} },
        scripting: {
            async getRegisteredContentScripts() { return []; },
            async unregisterContentScripts() {},
            async registerContentScripts(scripts) { registrations.push(...scripts); },
        },
    };
    context = vm.createContext({
        chrome, URL, console,
        importScripts(file) { vm.runInContext(fs.readFileSync(path.join(sourceDir, file), 'utf8'), context); },
    });
    vm.runInContext(fs.readFileSync(path.join(sourceDir, 'service-worker.js'), 'utf8'), context);
    return {
        nativeRequests, registrations, values,
        send(message, sender = { id: chrome.runtime.id, tab: { id: 7 }, url: 'https://emby.moear.de/web/index.html' }) {
            return new Promise((resolve) => handleMessage(message, sender, resolve));
        },
    };
}

function play(destination = 'default') {
    return {
        type: 'play-media',
        payload: {
            requestId: 'episode-4-request', mode: 'single', destination,
            items: [{ itemId: 'ep4', title: 'EP4', url: 'https://emby.moear.de/videos/ep4/stream.mkv' }],
        },
    };
}

test('默认网页时，一次性选择 PotPlayer 可启动且不修改默认值', async () => {
    const worker = createWorker({ enabled: false });
    assert.equal((await worker.send(play('potplayer'))).ok, true);
    assert.equal(worker.values.enabled, false);
    assert.equal(worker.nativeRequests.length, 1);
    assert.equal(worker.nativeRequests[0].items[0].itemId, 'ep4');
});

test('默认网页时，普通请求仍被拒绝', async () => {
    const worker = createWorker({ enabled: false });
    assert.equal((await worker.send(play())).ok, false);
    assert.equal(worker.nativeRequests.length, 0);
});

test('兼容旧版字符串配置，false 仍表示默认网页', async () => {
    const worker = createWorker({ enabled: 'false' });
    assert.equal((await worker.send(play())).ok, false);
    assert.equal((await worker.send(play('potplayer'))).ok, true);
    assert.equal(worker.nativeRequests.length, 1);
});

test('默认 PotPlayer 时，普通请求仍按原模式启动', async () => {
    const worker = createWorker();
    assert.equal((await worker.send(play())).ok, true);
    assert.equal(worker.nativeRequests[0].mode, 'single');
});

test('一次性选择不能绕过站点来源校验', async () => {
    const worker = createWorker({ enabled: false });
    const response = await worker.send(play('potplayer'), {
        id: 'bridge-extension', tab: { id: 7 }, url: 'https://unlisted.example.test/',
    });
    assert.equal(response.ok, false);
    assert.equal(worker.nativeRequests.length, 0);
});

test('非当前扩展的消息不能触发 PotPlayer', async () => {
    const worker = createWorker();
    const response = await worker.send(play('potplayer'), {
        id: 'other-extension', tab: { id: 7 }, url: 'https://emby.moear.de/web/',
    });
    assert.equal(response.ok, false);
    assert.equal(worker.nativeRequests.length, 0);
});

test('一次性选择仍遵守播放列表上限', async () => {
    const worker = createWorker({ enabled: false, maxPlaylistItems: 1 });
    const request = play('potplayer');
    request.payload.items.push({ itemId: 'ep5', url: 'https://emby.moear.de/videos/ep5/stream.mkv' });
    assert.equal((await worker.send(request)).ok, false);
    assert.equal(worker.nativeRequests.length, 0);
});

test('自定义站点也注册按钮脚本和样式', async () => {
    const worker = createWorker({ allowedOrigins: ['https://media.example.test'] });
    assert.equal((await worker.send({ type: 'sync-content-scripts' })).ok, true);
    const script = worker.registrations.find((entry) => entry.js.includes('content-script.js'));
    assert.ok(script.js.includes('playback-choice.js'));
    assert.ok(script.js.indexOf('playback-choice.js') < script.js.indexOf('content-script.js'));
    assert.equal(script.css[0], 'playback-choice.css');
});

test('静态注册的按钮脚本和样式全部存在', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
    const script = manifest.content_scripts.find((entry) => entry.js.includes('content-script.js'));
    assert.ok(script.js.includes('playback-choice.js'));
    assert.ok(script.css.includes('playback-choice.css'));
    for (const file of [...script.js, ...script.css]) assert.ok(fs.existsSync(path.join(sourceDir, file)), file);
});
