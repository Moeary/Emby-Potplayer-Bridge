'use strict';

(() => {
    const PAGE_SOURCE = 'codex-emby-jellyfin-potplayer-page';
    const REQUEST_TYPE = 'codex-potplayer-request';
    const RESPONSE_TYPE = 'codex-potplayer-response';
    const bypassClicks = new WeakSet();
    const pending = new Map();
    const settingsApi = globalThis.PotPlayerSettings;
    let settings = null;

    function normalizeSettings(raw) {
        if (settingsApi && typeof settingsApi.normalize === 'function') return settingsApi.normalize(raw);
        return {
            enabled: true,
            requestTimeoutSeconds: 120,
            fallbackToBrowser: true,
            allowedOrigins: [location.origin],
        };
    }

    function loadSettings() {
        chrome.storage.local.get(null, (values) => {
            settings = normalizeSettings(values);
        });
    }

    loadSettings();
    chrome.storage.onChanged.addListener(() => {
        loadSettings();
    });

    function asElement(value) {
        const element = value && value.nodeType === 1 ? value : value && value.parentElement;
        if (!element) return null;
        return element.closest('button, a, [role="button"], [data-action], .btnPlay, .btnReplay') || element;
    }

    function isInsideVideoPlayer(element) {
        return Boolean(element && element.closest('video, audio, .videoOsdPage, .videoOsd, .videoosd-page, .videoPlayer'));
    }

    function getButtonLabel(element) {
        return [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
            .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }

    function getPlaylistMode(element) {
        if (!element || isInsideVideoPlayer(element)) return '';
        const label = getButtonLabel(element);
        if (element.matches('.btnShuffle, [data-action="shuffle"]') || /随机播放|随机|shuffle/i.test(label)) return 'random';
        if (element.matches('.itemsViewSettingsContainer .btnPlay, .libraryPage .btnPlay')
            || /^(播放全部|全部播放|play all)$/i.test(label)) return 'all';
        return '';
    }

    function isPlaybackClick(element) {
        if (!element || isInsideVideoPlayer(element)) return false;
        const action = (element.getAttribute('data-action') || '').toLowerCase();
        if (action === 'play' || action === 'resume') return true;
        if (element.matches('.btnPlay, .btnReplay, [data-action="play"], [data-action="resume"]')) return true;
        return /^(播放|恢复播放|继续播放|play|resume|play now|resume playback)$/i.test(getButtonLabel(element));
    }

    function getHashParams() {
        const hash = String(location.hash || '');
        const index = hash.indexOf('?');
        return index >= 0 ? new URLSearchParams(hash.slice(index + 1)) : new URLSearchParams();
    }

    function findIdInUrl(value) {
        if (!value) return '';
        const text = String(value);
        const query = /(?:[?&#]|^)id=([^&#]+)/i.exec(text);
        if (query) return decodeURIComponent(query[1]);
        const item = /\/Items\/([^/]+)\//i.exec(text);
        return item ? decodeURIComponent(item[1]) : '';
    }

    function findItemId(target) {
        let node = target;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            const explicit = node.getAttribute && (node.getAttribute('data-id') || node.getAttribute('data-item-id') || node.getAttribute('data-entity-id'));
            if (explicit) return explicit;
            const hrefId = findIdInUrl(node.getAttribute && (node.getAttribute('href') || node.getAttribute('data-href')));
            if (hrefId) return hrefId;
            const image = node.querySelector && node.querySelector('img[src*="/Items/"]');
            const imageId = findIdInUrl(image && image.getAttribute('src'));
            if (imageId) return imageId;
        }
        const hash = getHashParams();
        const hashId = hash.get('id');
        return hashId && /details|item/i.test(location.hash || '') ? hashId : '';
    }

    function findContext(target) {
        const hash = getHashParams();
        return {
            parentId: hash.get('parentId') || '',
            serverId: hash.get('serverId') || '',
            itemId: findItemId(target),
        };
    }

    function fallbackToBrowser(target, reason, requestSettings = settings) {
        if (reason) console.warn('[PotPlayer Bridge]', reason);
        if (requestSettings && requestSettings.fallbackToBrowser === false) return;
        try {
            bypassClicks.add(target);
            target.click();
        } catch (_) {
            // 页面已经销毁或按钮不再存在时只能保持当前页面。
        }
    }

    function requestPlayback(target, mode, context) {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const requestSettings = settings || normalizeSettings({});
        const timer = window.setTimeout(() => {
            const request = pending.get(requestId);
            if (!request) return;
            pending.delete(requestId);
            fallbackToBrowser(request.target, '页面 API 响应超时', request.settings);
        }, requestSettings.requestTimeoutSeconds * 1000);
        pending.set(requestId, { target, timer, settings: requestSettings });
        window.postMessage({
            source: PAGE_SOURCE,
            type: REQUEST_TYPE,
            requestId,
            mode,
            context,
            settings: requestSettings,
        }, '*');
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.source !== PAGE_SOURCE || event.data.type !== RESPONSE_TYPE) return;
        const request = pending.get(event.data.requestId);
        if (!request) return;
        pending.delete(event.data.requestId);
        window.clearTimeout(request.timer);

        if (!event.data.ok || !Array.isArray(event.data.items) || !event.data.items.length) {
            fallbackToBrowser(request.target, event.data.error || '页面没有返回可播放项目', request.settings);
            return;
        }

        chrome.runtime.sendMessage({
            type: 'play-media',
            payload: { mode: event.data.mode, items: event.data.items, settings: request.settings },
        }, (response) => {
            const lastError = chrome.runtime.lastError;
            if (lastError || !response || response.ok !== true) {
                fallbackToBrowser(request.target, lastError && lastError.message || response && response.error || '本地 PotPlayer 桥接失败', request.settings);
            }
        });
    });

    document.addEventListener('click', (event) => {
        if (!settings || settings.enabled === false || !settings.allowedOrigins.includes(location.origin)) return;
        const target = asElement(event.target);
        if (!target) return;
        if (bypassClicks.has(target)) {
            bypassClicks.delete(target);
            return;
        }

        const mode = getPlaylistMode(target) || (isPlaybackClick(target) ? 'single' : '');
        if (!mode) return;
        const context = findContext(target);
        if (mode !== 'single' && !context.parentId && !context.itemId) return;
        if (mode === 'single' && !context.itemId) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        requestPlayback(target, mode, context);
    }, true);
})();
