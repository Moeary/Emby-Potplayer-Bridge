'use strict';

(() => {
    const PAGE_SOURCE = 'codex-emby-jellyfin-potplayer-page';
    const REQUEST_TYPE = 'codex-potplayer-request';
    const RESPONSE_TYPE = 'codex-potplayer-response';
    const PLAYBACK_EVENT_TYPE = 'codex-potplayer-playback-event';
    const ACTIONABLE_SELECTOR = [
        'button',
        'a',
        '[role="button"]',
        '[data-action]',
        '[data-play-action]',
        '[data-testid*="play" i]',
        '[aria-label*="play" i]',
        '[title*="play" i]',
        '.btnPlay',
        '.btnReplay',
        '.btnResume',
        '.playButton',
        '.play-button',
        '.playbackButton',
        '.playback-button',
        '.btnPlayAll',
        '.btnShuffle',
    ].join(',');
    const bypassClicks = new WeakSet();
    const pending = new Map();
    const settingsApi = globalThis.PotPlayerSettings;
    let settings = null;
    let playbackGeneration = 0;
    const choiceUi = globalThis.PotPlayerPlaybackChoice?.create({
        getSettings: () => settings,
        getMode: (target) => getPlaybackMode(target),
    });

    function normalizeSettings(raw) {
        if (settingsApi && typeof settingsApi.normalize === 'function') return settingsApi.normalize(raw);
        return {
            enabled: true,
            requestTimeoutSeconds: 120,
            fallbackToBrowser: true,
            allowedOrigins: [location.origin],
            resumePlayback: true,
            syncPlayback: true,
        };
    }

    function loadSettings() {
        chrome.storage.local.get(null, (values) => {
            const nextSettings = normalizeSettings(values);
            if (settings && (settings.enabled !== nextSettings.enabled
                || settings.allowedOrigins.join() !== nextSettings.allowedOrigins.join())) {
                cancelPendingPlayback();
            }
            settings = nextSettings;
            choiceUi?.refresh();
        });
    }

    loadSettings();
    chrome.storage.onChanged.addListener((_changes, area) => {
        if (area === 'local') loadSettings();
    });

    function isElement(value) {
        return Boolean(value && value.nodeType === 1);
    }

    function asElement(event) {
        const path = event && typeof event.composedPath === 'function' ? event.composedPath() : [];
        const candidates = [event && event.target, ...path];
        for (const value of candidates) {
            if (!isElement(value)) continue;
            const actionable = typeof value.closest === 'function'
                ? value.closest(ACTIONABLE_SELECTOR)
                : null;
            if (actionable) return actionable;
        }
        return candidates.find(isElement) || null;
    }

    function isInsideVideoPlayer(element) {
        return Boolean(element && element.closest(
            'video, audio, .videoOsdPage, .videoOsd, .videoosd-page, .videoPlayer, '
            + '.videoPlayerContainer, [data-role="video-player"], [data-video-player]',
        ));
    }

    function getButtonLabel(element) {
        return [
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.getAttribute('data-action'),
            element.getAttribute('data-testid'),
            element.textContent,
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }

    function getAction(element) {
        return String(element && (
            element.getAttribute('data-action')
            || element.getAttribute('data-play-action')
            || ''
        )).trim().toLowerCase();
    }

    function getPlaylistMode(element) {
        if (!element || isInsideVideoPlayer(element)) return '';
        const action = getAction(element);
        const label = getButtonLabel(element);
        if (element.matches('.btnShuffle, [data-action="shuffle" i], [data-action="random" i]')
            || /随机播放|随机|shuffle|random/i.test(label)
            || /^(?:play[-_ ]?)?(?:shuffle|random)$/.test(action)) return 'random';
        if (element.matches(
            '.itemsViewSettingsContainer .btnPlay, '
            + '.btnPlayAll, .playAll, .play-all, [data-action="playall" i], '
            + '[data-action="play-all" i], [data-play-action="all" i]',
        ) || /播放全部|全部播放|播放所有|play all|play everything/i.test(label)
            || /^(?:play[-_ ]?all|all[-_ ]?play)$/.test(action)) return 'all';
        return '';
    }

    function isPlaybackClick(element) {
        if (!element || isInsideVideoPlayer(element)) return false;
        const action = getAction(element);
        if (/^(?:play|resume|playback|play-now|resume-playback)$/.test(action)) return true;
        if (element.matches(
            '.btnPlay, .btnReplay, .btnResume, .playButton, .play-button, .playbackButton, .playback-button, '
            + '[data-action="play" i], [data-action="resume" i], [data-play-action="play" i]',
        )) return true;

        const label = getButtonLabel(element);
        return /^(?:播放|恢复播放|继续播放|立即播放|播放此项目|从头播放)(?:\s|$)/i.test(label)
            || /(?:^|\s)(?:play|resume|play now|resume playback)(?:\s|$)/i.test(label);
    }

    function getPlaybackMode(target) {
        if (!target || target.closest('[data-potplayer-choice]')
            || target.disabled || target.getAttribute('aria-disabled') === 'true') return '';
        return getPlaylistMode(target) || (isPlaybackClick(target) ? 'single' : '');
    }

    function isAllowedSite() {
        return settings && settings.allowedOrigins.includes(location.origin);
    }

    function cancelPendingPlayback() {
        playbackGeneration += 1;
        for (const request of pending.values()) window.clearTimeout(request.timer);
        pending.clear();
    }

    function isCurrentRequest(request) {
        return request.generation === playbackGeneration && request.pageUrl === location.href
            && request.target.isConnected && isAllowedSite();
    }

    function playInBrowser(target) {
        cancelPendingPlayback();
        if (!target.isConnected) return;
        // click() 同步触发事件；放行只限本次调用，不影响默认设置或下一次点击。
        bypassClicks.add(target);
        try { target.click(); } finally { bypassClicks.delete(target); }
    }

    window.addEventListener('hashchange', cancelPendingPlayback);
    window.addEventListener('popstate', cancelPendingPlayback);

    function getHashParams() {
        const hash = String(location.hash || '');
        const index = hash.indexOf('?');
        return index >= 0 ? new URLSearchParams(hash.slice(index + 1)) : new URLSearchParams();
    }

    function getPageItemId() {
        const hash = getHashParams();
        const hashId = hash.get('id') || hash.get('itemId');
        return hashId && /(?:details|item)/i.test(location.hash || '') ? hashId : '';
    }

    function decodeId(value) {
        try {
            return decodeURIComponent(String(value));
        } catch (_) {
            return String(value);
        }
    }

    function findIdInUrl(value) {
        if (!value) return '';
        const text = String(value);
        const query = /(?:[?&#]|^)(?:id|itemId)=([^&#]+)/i.exec(text);
        if (query) return decodeId(query[1]);
        const item = /\/items?\/([^/?#]+)/i.exec(text);
        return item ? decodeId(item[1]) : '';
    }

    function getSiteProvider() {
        const hint = (String(location.hostname) + ' ' + String(location.pathname)).toLowerCase();
        if (hint.includes('jellyfin')) return 'jellyfin';
        if (hint.includes('emby')) return 'emby';
        return '';
    }

    function explicitItemId(node) {
        return node && node.getAttribute && (
            node.getAttribute('data-id')
            || node.getAttribute('data-item-id')
            || node.getAttribute('data-itemid')
            || node.getAttribute('data-entity-id')
            || node.getAttribute('data-emby-id')
            || node.getAttribute('data-jellyfin-id')
        ) || '';
    }

    function isItemScope(node) {
        if (!node || typeof node.matches !== 'function') return false;
        if (node.matches(
            'a[href*="id=" i], a[href*="/Items/" i], [data-item-id], [data-itemid], '
            + '[data-entity-id], [data-emby-id], [data-jellyfin-id], '
            + '.card, .cardBox, .listItem, .itemTile, .itemCell, .libraryItem, .mediaItem',
        )) return true;
        const className = String(node.className || '');
        return /(?:^|\s)(?:card|cardbox|listitem|itemtile|itemcell|libraryitem|mediaitem|episodeitem|movieitem)(?:$|\s)/i.test(className);
    }

    function findItemId(target) {
        const pageItemId = getPageItemId();
        let node = target;
        for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
            const hrefId = findIdInUrl(node.getAttribute && (
                node.getAttribute('href') || node.getAttribute('data-href')
            ));
            if (hrefId) return hrefId;

            const explicit = explicitItemId(node);
            if (explicit && isItemScope(node)) return explicit;

            if (isItemScope(node)) {
                const image = node.querySelector && node.querySelector(
                    'img[src*="/Items/" i], img[data-src*="/Items/" i]',
                );
                const imageId = image && findIdInUrl(
                    image.getAttribute('src')
                    || image.getAttribute('data-src')
                    || image.getAttribute('data-href'),
                );
                if (imageId) return imageId;
                return '';
            }
        }
        return pageItemId;
    }

    function findContext(target) {
        const hash = getHashParams();
        return {
            parentId: hash.get('parentId') || '',
            serverId: hash.get('serverId') || '',
            itemId: findItemId(target),
            pageItemId: getPageItemId(),
            provider: getSiteProvider(),
        };
    }

    function fallbackToBrowser(target, reason, requestSettings = settings) {
        if (reason) console.warn('[PotPlayer Bridge]', reason);
        if (requestSettings && requestSettings.fallbackToBrowser === false) return;
        try {
            playInBrowser(target);
        } catch (_) {
            // 页面已经销毁或按钮不再存在时只能保持当前页面。
        }
    }

    function requestPlayback(target, mode, context, destination = 'default') {
        cancelPendingPlayback();
        const requestId = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
        const requestSettings = settings || normalizeSettings({});
        const timer = window.setTimeout(() => {
            const request = pending.get(requestId);
            if (!request) return;
            pending.delete(requestId);
            if (isCurrentRequest(request)) {
                fallbackToBrowser(request.target, '页面 API 响应超时', request.settings);
            }
        }, requestSettings.requestTimeoutSeconds * 1000);
        pending.set(requestId, {
            target, timer, mode, destination, settings: requestSettings,
            generation: playbackGeneration, pageUrl: location.href,
        });
        window.postMessage({
            source: PAGE_SOURCE,
            type: REQUEST_TYPE,
            requestId,
            mode,
            context,
            settings: requestSettings,
        }, '*');
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (!message || message.type !== 'potplayer-playback-event') return;
        window.postMessage({
            source: PAGE_SOURCE,
            type: PLAYBACK_EVENT_TYPE,
            event: message.event || '',
            requestId: message.requestId || '',
            sessionId: message.sessionId || '',
            itemId: message.itemId || '',
            playlistIndex: message.playlistIndex,
            positionTicks: message.positionTicks,
            runtimeTicks: message.runtimeTicks,
        }, '*');
    });

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.source !== PAGE_SOURCE || event.data.type !== RESPONSE_TYPE) return;
        const request = pending.get(event.data.requestId);
        if (!request) return;
        pending.delete(event.data.requestId);
        window.clearTimeout(request.timer);
        if (!isCurrentRequest(request)) return;

        if (!event.data.ok || !Array.isArray(event.data.items) || !event.data.items.length) {
            fallbackToBrowser(request.target, event.data.error || '页面没有返回可播放项目', request.settings);
            return;
        }

        chrome.runtime.sendMessage({
            type: 'play-media',
            payload: {
                requestId: event.data.requestId,
                mode: request.mode,
                destination: request.destination,
                items: event.data.items,
                settings: request.settings,
            },
        }, (response) => {
            const lastError = chrome.runtime.lastError;
            if (!isCurrentRequest(request)) return;
            if (lastError || !response || response.ok !== true) {
                fallbackToBrowser(request.target, lastError && lastError.message || response && response.error || '本地 PotPlayer 桥接失败', request.settings);
                return;
            }
            if (response.sessionId && request.settings.syncPlayback !== false) {
                window.postMessage({
                    source: PAGE_SOURCE,
                    type: PLAYBACK_EVENT_TYPE,
                    event: 'started',
                    requestId: event.data.requestId,
                    sessionId: response.sessionId,
                }, '*');
            }
        });
    });

    document.addEventListener('click', (event) => {
        const target = asElement(event);
        if (!target) return;
        if (bypassClicks.has(target)) {
            bypassClicks.delete(target);
            return;
        }
        if (!isAllowedSite()) return;

        const choice = choiceUi?.getSelection(target);
        const original = choice ? choice.target : target;
        const mode = getPlaybackMode(original);
        if (!mode) return;

        if (choice?.destination === 'web') {
            event.preventDefault();
            event.stopImmediatePropagation();
            playInBrowser(original);
            return;
        }

        if (!choice && settings.enabled === false) {
            cancelPendingPlayback();
            return;
        }
        const context = findContext(original);
        if (mode !== 'single' && !context.parentId && !context.itemId) return;
        if (mode === 'single' && !context.itemId) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        requestPlayback(original, mode, context, choice ? 'potplayer' : 'default');
    }, true);
})();
