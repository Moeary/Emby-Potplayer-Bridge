'use strict';

importScripts('settings.js');

const NATIVE_HOST = 'com.codex.potplayer_bridge';
const SETTINGS = globalThis.PotPlayerSettings;
const HARD_MAX_PLAYLIST_ITEMS = 4096;
const DYNAMIC_SCRIPT_PREFIX = 'potplayer-dynamic-';
const STATIC_ORIGINS = new Set(SETTINGS.DEFAULTS.allowedOrigins);
let syncQueue = Promise.resolve();
const ACTIVE_NATIVE_PORTS = new Map();

function updateBadge(enabled) {
    const text = enabled ? 'P' : 'W';
    void chrome.action.setBadgeText({ text });
    void chrome.action.setBadgeBackgroundColor({ color: enabled ? '#237a4b' : '#666a73' });
    void chrome.action.setTitle({
        title: enabled ? '默认使用 PotPlayer（页面旁边可临时选择网页）' : '默认使用网页（页面旁边可临时选择 PotPlayer）',
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
    updateBadge(values.defaultPlayer === 'potplayer');
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
        updateBadge(values.defaultPlayer === 'potplayer');
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
    const tabId = sender && sender.tab && sender.tab.id;
    if (!items.length) {
        sendResponse({ ok: false, error: '播放列表为空' });
        return false;
    }

    (async () => {
        try {
            const settings = await readSettings();
            let senderOrigin = '';
            try { senderOrigin = new URL(sender.url || '').origin; } catch (_) { /* 非网页消息 */ }
            if (sender.id !== chrome.runtime.id || tabId == null
                || !settings.allowedOrigins.includes(senderOrigin)) {
                sendResponse({ ok: false, error: '当前网页不在允许使用的站点中' });
                return;
            }
            if (settings.defaultPlayer !== 'potplayer' && payload.destination !== 'potplayer') {
                sendResponse({ ok: false, error: 'PotPlayer 外部播放已关闭' });
                return;
            }
            if (items.length > Math.min(settings.maxPlaylistItems, HARD_MAX_PLAYLIST_ITEMS)) {
                sendResponse({ ok: false, error: `播放列表超过当前上限 ${settings.maxPlaylistItems} 项` });
                return;
            }
            const response = await sendNative({
                type: 'play',
                requestId: payload.requestId || '',
                sessionId: makeSessionId(),
                syncPlayback: settings.syncPlayback === true && tabId != null,
                mode: payload.mode || 'single',
                items,
                allowedOrigins: settings.allowedOrigins,
            }, tabId);
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
            js: ['settings.js', 'adapters/provider-core.js', 'adapters/emby.js', 'adapters/jellyfin.js', 'page-bridge.js'],
            runAt: 'document_start',
            world: 'MAIN',
            persistAcrossSessions: true,
        });
        scripts.push({
            id: makeDynamicScriptId(origin, 'content'),
            matches,
            js: ['settings.js', 'playback-choice.js', 'content-script.js'],
            css: ['playback-choice.css'],
            runAt: 'document_start',
            persistAcrossSessions: true,
        });
    }
    await chrome.scripting.registerContentScripts(scripts);
}

function makeSessionId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return 'potplayer-' + globalThis.crypto.randomUUID();
    }
    return 'potplayer-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2);
}

function sendNative(payload, tabId) {
    return new Promise((resolve, reject) => {
        let initialSettled = false;
        let closed = false;
        let port;

        const cleanup = () => {
            if (tabId == null) return;
            const current = ACTIVE_NATIVE_PORTS.get(tabId);
            if (current && current.port === port) ACTIVE_NATIVE_PORTS.delete(tabId);
        };
        const close = () => {
            if (closed) return;
            closed = true;
            cleanup();
            try { if (port) port.disconnect(); } catch (_) { /* ignore */ }
        };
        const forward = (response, eventName) => {
            if (tabId == null) return;
            void chrome.tabs.sendMessage(tabId, {
                ...(response || {}),
                type: 'potplayer-playback-event',
                event: eventName,
                requestId: payload.requestId || '',
                sessionId: payload.sessionId || '',
            }).catch(() => undefined);
        };

        try {
            const previous = tabId == null ? null : ACTIVE_NATIVE_PORTS.get(tabId);
            if (previous && previous.port) {
                try { previous.port.disconnect(); } catch (_) { /* ignore */ }
            }

            port = chrome.runtime.connectNative(NATIVE_HOST);
            if (tabId != null) ACTIVE_NATIVE_PORTS.set(tabId, {
                port,
                sessionId: payload.sessionId || '',
            });
            port.onMessage.addListener((response) => {
                if (!initialSettled) {
                    initialSettled = true;
                    if (!response || response.ok !== true) {
                        close();
                        resolve(response);
                        return;
                    }
                    resolve({ ...response, sessionId: payload.sessionId || '' });
                    return;
                }
                if (response && response.type === 'playback-progress') {
                    forward(response, 'progress');
                } else if (response && response.type === 'playback-stopped') {
                    forward(response, 'stopped');
                    close();
                }
            });
            port.onDisconnect.addListener(() => {
                if (closed) return;
                cleanup();
                if (!initialSettled) {
                    closed = true;
                    const lastError = chrome.runtime.lastError;
                    reject(new Error(lastError && lastError.message || 'Native Messaging 连接已断开'));
                    return;
                }
                forward({ type: 'playback-stopped' }, 'stopped');
                closed = true;
            });
            port.postMessage({ ...payload, sessionId: payload.sessionId || makeSessionId() });
        } catch (error) {
            close();
            reject(error);
        }
    });
}
