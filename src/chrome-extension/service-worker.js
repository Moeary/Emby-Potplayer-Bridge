'use strict';

importScripts('settings.js');

const NATIVE_HOST = 'com.codex.potplayer_bridge';
const SETTINGS = globalThis.PotPlayerSettings;
const HARD_MAX_PLAYLIST_ITEMS = 4096;
const DYNAMIC_SCRIPT_PREFIX = 'potplayer-dynamic-';
const STATIC_ORIGINS = new Set(SETTINGS.DEFAULTS.allowedOrigins);
let syncQueue = Promise.resolve();

function updateBadge(enabled) {
    const text = enabled ? 'P' : 'W';
    void chrome.action.setBadgeText({ text });
    void chrome.action.setBadgeBackgroundColor({ color: enabled ? '#237a4b' : '#666a73' });
    void chrome.action.setTitle({
        title: enabled ? 'PotPlayer 外部播放（打开弹框修改设置）' : '浏览器内置播放（打开弹框修改设置）',
    });
}

function readSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(null, (values) => resolve(SETTINGS.normalize(values)));
    });
}

async function initializeSettings() {
    const values = await readSettings();
    await chrome.storage.local.set(values);
    updateBadge(values.enabled);
    await scheduleDynamicContentSync();
}

chrome.runtime.onInstalled.addListener(() => {
    void initializeSettings().catch((error) => console.warn('[PotPlayer Bridge]', error));
});

chrome.runtime.onStartup.addListener(() => {
    void initializeSettings().catch((error) => console.warn('[PotPlayer Bridge]', error));
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    void readSettings().then((values) => {
        updateBadge(values.enabled);
        return scheduleDynamicContentSync();
    }).catch((error) => console.warn('[PotPlayer Bridge]', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;

    if (message.type === 'sync-content-scripts') {
        scheduleDynamicContentSync()
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({ ok: false, error: error && error.message || '动态站点注册失败' }));
        return true;
    }

    if (message.type !== 'play-media') return false;

    const payload = message.payload || {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
        sendResponse({ ok: false, error: '播放列表为空' });
        return false;
    }

    (async () => {
        try {
            const settings = await readSettings();
            if (!settings.enabled) {
                sendResponse({ ok: false, error: 'PotPlayer 外部播放已关闭' });
                return;
            }
            if (items.length > Math.min(settings.maxPlaylistItems, HARD_MAX_PLAYLIST_ITEMS)) {
                sendResponse({ ok: false, error: `播放列表超过当前上限 ${settings.maxPlaylistItems} 项` });
                return;
            }
            const response = await sendNative({
                type: 'play',
                mode: payload.mode || 'single',
                items,
                allowedOrigins: settings.allowedOrigins,
            });
            sendResponse(response && response.ok
                ? response
                : { ok: false, error: response && response.error || '本地桥接程序没有确认播放' });
        } catch (error) {
            sendResponse({
                ok: false,
                error: error && error.message ? error.message : '无法连接 PotPlayer 本地桥接程序',
            });
        }
    })();
    return true;
});

function scheduleDynamicContentSync() {
    syncQueue = syncQueue.catch(() => undefined).then(() => syncDynamicContentScripts());
    return syncQueue;
}

function makeOriginHash(origin) {
    let hash = 2166136261;
    for (let index = 0; index < origin.length; index += 1) {
        hash ^= origin.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function makeDynamicScriptId(origin, suffix) {
    return `${DYNAMIC_SCRIPT_PREFIX}${suffix}-${makeOriginHash(origin)}`;
}

async function syncDynamicContentScripts() {
    if (!chrome.scripting || typeof chrome.scripting.getRegisteredContentScripts !== 'function') return;

    const registered = await chrome.scripting.getRegisteredContentScripts();
    const oldIds = registered
        .map((script) => script.id)
        .filter((id) => id.startsWith(DYNAMIC_SCRIPT_PREFIX));
    if (oldIds.length) await chrome.scripting.unregisterContentScripts({ ids: oldIds });

    const settings = await readSettings();
    const dynamicOrigins = settings.allowedOrigins.filter((origin) => !STATIC_ORIGINS.has(origin));
    if (!dynamicOrigins.length) return;

    const scripts = [];
    for (const origin of dynamicOrigins) {
        const matches = [`${origin}/*`];
        scripts.push({
            id: makeDynamicScriptId(origin, 'page'),
            matches,
            js: ['settings.js', 'page-bridge.js'],
            runAt: 'document_start',
            world: 'MAIN',
            persistAcrossSessions: true,
        });
        scripts.push({
            id: makeDynamicScriptId(origin, 'content'),
            matches,
            js: ['settings.js', 'content-script.js'],
            runAt: 'document_start',
            persistAcrossSessions: true,
        });
    }
    await chrome.scripting.registerContentScripts(scripts);
}

function sendNative(payload) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let port;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            try { if (port) port.disconnect(); } catch (_) { /* ignore */ }
            callback(value);
        };

        try {
            port = chrome.runtime.connectNative(NATIVE_HOST);
            port.onMessage.addListener((response) => finish(resolve, response));
            port.onDisconnect.addListener(() => {
                if (settled) return;
                const lastError = chrome.runtime.lastError;
                finish(reject, new Error(lastError && lastError.message || 'Native Messaging 连接已断开'));
            });
            port.postMessage(payload);
        } catch (error) {
            finish(reject, error);
        }
    });
}
