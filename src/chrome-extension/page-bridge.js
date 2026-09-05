'use strict';

(() => {
    const PAGE_SOURCE = 'codex-emby-jellyfin-potplayer-page';
    const REQUEST_TYPE = 'codex-potplayer-request';
    const RESPONSE_TYPE = 'codex-potplayer-response';
    const page = window;
    const settingsApi = page.PotPlayerSettings;
    const adapterCore = page.PotPlayerMediaAdapterCore;

    const sleep = (ms) => new Promise((resolve) => page.setTimeout(resolve, ms));

    function normalizeSettings(raw) {
        if (settingsApi && typeof settingsApi.normalize === 'function') {
            try { return settingsApi.normalize(raw); } catch (_) { /* 使用后备配置 */ }
        }
        return {
            maxPlaylistItems: 1024,
            mediaSourceConcurrency: 6,
            requestTimeoutSeconds: 120,
            skipUnavailable: true,
            resumePlayback: true,
            syncPlayback: true,
        };
    }

    const PLAYBACK_EVENT_TYPE = 'codex-potplayer-playback-event';
    const resolvedRequests = new Map();
    const activePlaybackSessions = new Map();
    const PLAYBACK_REPORT_METHODS = Object.freeze({
        started: 'reportPlaybackStart',
        progress: 'reportPlaybackProgress',
        stopped: 'reportPlaybackStopped',
    });

    function finitePlaybackTicks(value) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
    }

    function rememberResolvedRequest(requestId, state) {
        const key = String(requestId || '');
        if (!key) return;
        resolvedRequests.set(key, state);
        page.setTimeout(() => {
            if (resolvedRequests.get(key) === state) resolvedRequests.delete(key);
        }, 10 * 60 * 1000);
    }

    function findPlaybackEntry(session, eventData) {
        const itemId = String(eventData && eventData.itemId || '');
        if (itemId) {
            const byId = session.items.find((entry) => String(entry.itemId || '') === itemId);
            if (byId) return byId;
        }
        const index = Number(eventData && eventData.playlistIndex);
        if (Number.isInteger(index) && index >= 0 && index < session.items.length) {
            session.currentIndex = index;
            return session.items[index];
        }
        return session.items[session.currentIndex] || session.items[0];
    }

    function playbackInfo(session, kind, entry, eventData) {
        const eventTicks = finitePlaybackTicks(eventData && eventData.positionTicks);
        const positionTicks = eventData && Number.isFinite(Number(eventData.positionTicks))
            ? eventTicks
            : finitePlaybackTicks(session.lastPositionTicks || entry.startPositionTicks);
        const eventRuntime = finitePlaybackTicks(eventData && eventData.runtimeTicks);
        const runtimeTicks = eventData && Number.isFinite(Number(eventData.runtimeTicks))
            ? eventRuntime
            : finitePlaybackTicks(session.lastRuntimeTicks || entry.runtimeTicks);
        const info = {
            ItemId: String(entry.itemId || ''),
            PositionTicks: positionTicks,
            RunTimeTicks: runtimeTicks,
            PlaySessionId: session.sessionId,
            CanSeek: true,
            IsPaused: false,
            IsMuted: false,
            PlayMethod: 'DirectPlay',
            QueueableMediaTypes: ['Video'],
            PlaylistIndex: session.currentIndex,
            PlaylistLength: session.items.length,
            EventName: kind === 'progress'
                ? 'TimeUpdate'
                : kind === 'started' ? 'PlaybackStart' : 'PlaybackStop',
        };
        if (entry.mediaSourceId) info.MediaSourceId = String(entry.mediaSourceId);
        return info;
    }

    async function reportWithFetch(session, endpointName, info) {
        const token = adapterCore.getAccessToken(session.api);
        if (!token) throw new Error('页面登录会话已失效，无法同步播放进度');
        const relativePath = String(session.adapter.serverPath || '') + '/Sessions/' + endpointName;
        const endpoint = adapterCore.makeApiUrl(session.api, relativePath, session.adapter);
        endpoint.searchParams.set('api_key', token);
        const response = await page.fetch(endpoint.href, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': token,
                'X-MediaBrowser-Token': token,
            },
            body: JSON.stringify(info),
        });
        if (!response.ok) throw new Error('播放进度同步失败（HTTP ' + response.status + '）');
    }

    async function reportPlayback(session, kind, entry, eventData) {
        const info = playbackInfo(session, kind, entry, eventData);
        const methodName = PLAYBACK_REPORT_METHODS[kind];
        const method = methodName && session.api && session.api[methodName];
        if (typeof method === 'function') {
            try {
                await method.call(session.api, info);
                return;
            } catch (error) {
                console.warn('[PotPlayer Bridge] 页面 API 回报失败，尝试兼容接口', error && error.message || error);
            }
        }
        await reportWithFetch(
            session,
            kind === 'started' ? 'Playing' : kind === 'progress' ? 'Playing/Progress' : 'Playing/Stopped',
            info,
        );
    }

    function queuePlaybackReport(session, kind, entry, eventData) {
        if (!entry || !entry.itemId) return;
        const reportData = { ...(eventData || {}) };
        if (!Number.isFinite(Number(reportData.positionTicks))) {
            reportData.positionTicks = finitePlaybackTicks(session.lastPositionTicks || entry.startPositionTicks);
        }
        if (!Number.isFinite(Number(reportData.runtimeTicks))) {
            reportData.runtimeTicks = finitePlaybackTicks(session.lastRuntimeTicks || entry.runtimeTicks);
        }
        session.reportQueue = session.reportQueue
            .then(() => reportPlayback(session, kind, entry, reportData))
            .catch((error) => console.warn('[PotPlayer Bridge] 播放进度同步失败', error && error.message || error));
    }

    function startPlaybackSession(eventData) {
        const requestId = String(eventData && eventData.requestId || '');
        const stored = resolvedRequests.get(requestId);
        const sessionId = String(eventData && eventData.sessionId || '');
        if (!stored || !sessionId || stored.settings.syncPlayback === false) return;
        const session = {
            ...stored,
            sessionId,
            currentIndex: 0,
            lastPositionTicks: stored.items[0] && stored.items[0].startPositionTicks || 0,
            lastRuntimeTicks: stored.items[0] && stored.items[0].runtimeTicks || 0,
            reportQueue: Promise.resolve(),
        };
        activePlaybackSessions.set(sessionId, session);
        queuePlaybackReport(session, 'started', session.items[0], eventData);
    }

    function updatePlaybackSession(eventData) {
        const sessionId = String(eventData && eventData.sessionId || '');
        const session = activePlaybackSessions.get(sessionId);
        if (!session) return;
        const entry = findPlaybackEntry(session, eventData);
        if (!entry) return;
        if (Number.isFinite(Number(eventData.positionTicks))) {
            session.lastPositionTicks = finitePlaybackTicks(eventData.positionTicks);
        }
        if (Number.isFinite(Number(eventData.runtimeTicks))) {
            session.lastRuntimeTicks = finitePlaybackTicks(eventData.runtimeTicks);
        }
        queuePlaybackReport(session, 'progress', entry, eventData);
    }

    function stopPlaybackSession(eventData) {
        const sessionId = String(eventData && eventData.sessionId || '');
        const session = activePlaybackSessions.get(sessionId);
        if (!session) return;
        const entry = findPlaybackEntry(session, eventData);
        if (entry) queuePlaybackReport(session, 'stopped', entry, eventData);
        activePlaybackSessions.delete(sessionId);
    }

    function getApiClient(serverId) {
        try {
            const candidates = [page.ApiClient, page.apiClient];
            for (const candidate of candidates) {
                if (candidate && (typeof candidate.getItem === 'function'
                    || typeof candidate.getItems === 'function'
                    || typeof candidate.getPlaybackInfo === 'function')) return candidate;
            }

            const managers = [page.ConnectionManager, page.connectionManager];
            for (const manager of managers) {
                if (!manager || typeof manager.getApiClient !== 'function') continue;
                let candidate = null;
                try {
                    if (serverId) candidate = manager.getApiClient(serverId);
                } catch (_) {
                    // 某些客户端只接受无参数调用。
                }
                if (!candidate) {
                    try { candidate = manager.getApiClient(); } catch (_) { /* 继续等待 */ }
                }
                if (candidate) return candidate;
            }
        } catch (_) {
            // 页面应用可能尚未完成初始化。
        }
        return null;
    }

    async function waitForApiClient(serverId, timeoutMs = 12000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const api = getApiClient(serverId);
            if (api && (typeof api.getItem === 'function'
                || typeof api.getItems === 'function'
                || typeof api.getPlaybackInfo === 'function')) return api;
            await sleep(100);
        }
        return null;
    }

    async function getUserId(api) {
        if (api._serverInfo && api._serverInfo.UserId) return api._serverInfo.UserId;
        if (typeof api.getCurrentUserId === 'function') return await api.getCurrentUserId();
        if (typeof api.getCurrentUser === 'function') {
            const user = await api.getCurrentUser();
            if (user && user.Id) return user.Id;
        }
        return '';
    }

    async function buildEntries(adapter, api, userId, items, settings) {
        const entries = new Array(items.length);
        let skipped = 0;
        let nextIndex = 0;

        async function worker() {
            while (true) {
                const index = nextIndex++;
                if (index >= items.length) return;
                const item = items[index];
                try {
                    const source = (await adapterCore.getMediaSources(api, userId, item))[0];
                    if (!source) {
                        skipped += 1;
                        continue;
                    }
                    const entry = adapterCore.buildEntry(api, item, source, adapter, {
                        ...settings,
                        includeStreamStartTime: false,
                    });
                    if (entry) entries[index] = { entry, item, source };
                    else skipped += 1;
                } catch (_) {
                    skipped += 1;
                }
            }
        }

        const workerCount = Math.min(settings.mediaSourceConcurrency, items.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        const playableEntries = entries.filter(Boolean);
        if (!playableEntries.length) throw new Error('没有生成可播放的视频地址');
        if (!settings.skipUnavailable && skipped) {
            throw new Error('有 ' + skipped + ' 项没有可用媒体源，已按设置停止播放');
        }

        return playableEntries.map((record, index) => {
            const entry = record.entry;
            if (index === 0 || settings.resumePlayback === false) return entry;
            const url = adapterCore.buildStreamUrl(api, record.item, record.source, adapter, {
                ...settings,
                includeStreamStartTime: true,
            });
            return url ? { ...entry, url } : entry;
        });
    }

    async function resolveSingle(adapter, api, userId, context, settings) {
        const item = await adapterCore.getItem(api, userId, context.itemId);
        const candidates = await adapterCore.getSingleCandidates(
            api,
            userId,
            item,
            settings.maxPlaylistItems,
        );
        for (const candidate of candidates) {
            try {
                const source = (await adapterCore.getMediaSources(api, userId, candidate))[0];
                if (!source) continue;
                const entry = adapterCore.buildEntry(api, candidate, source, adapter, settings);
                if (entry) return [entry];
            } catch (_) {
                // 系列中某一集暂时不可用时继续寻找下一集。
            }
        }
        throw new Error('当前媒体没有可用视频源');
    }

    async function handleRequest(data) {
        const context = data.context || {};
        const settings = normalizeSettings(data.settings);
        if (!adapterCore) throw new Error('媒体适配器尚未加载');

        const api = await waitForApiClient(context.serverId, settings.requestTimeoutSeconds * 1000);
        if (!api) throw new Error('未找到页面 API');
        const userId = await getUserId(api);
        if (!userId) throw new Error('未找到当前登录用户');

        const adapter = adapterCore.resolve(context.provider, api);
        if (!adapter) throw new Error('未识别 Emby/Jellyfin 服务');

        if (data.mode === 'single') {
            const items = await resolveSingle(adapter, api, userId, context, settings);
            rememberResolvedRequest(data.requestId, { api, adapter, userId, items, settings });
            return items;
        }

        let items = await adapterCore.getPlaylistItems(api, userId, context, settings.maxPlaylistItems);
        if (data.mode === 'random') {
            items = items.slice();
            for (let index = items.length - 1; index > 0; index -= 1) {
                const swapIndex = Math.floor(Math.random() * (index + 1));
                [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
            }
        }
        if (items.length > settings.maxPlaylistItems) {
            throw new Error('当前目录有 ' + items.length + ' 项，超过当前上限 ' + settings.maxPlaylistItems + ' 项');
        }

        const entries = await buildEntries(adapter, api, userId, items, settings);
        rememberResolvedRequest(data.requestId, { api, adapter, userId, items: entries, settings });
        return entries;
    }

    page.addEventListener('message', (event) => {
        if (event.source !== page || !event.data || event.data.source !== PAGE_SOURCE) return;
        if (event.data.type === PLAYBACK_EVENT_TYPE) {
            if (event.data.event === 'started') startPlaybackSession(event.data);
            else if (event.data.event === 'progress') updatePlaybackSession(event.data);
            else if (event.data.event === 'stopped') stopPlaybackSession(event.data);
            return;
        }
        if (event.data.type !== REQUEST_TYPE) return;
        const respond = (payload) => page.postMessage({
            source: PAGE_SOURCE,
            type: RESPONSE_TYPE,
            requestId: event.data.requestId,
            mode: event.data.mode,
            ...payload,
        }, '*');
        void handleRequest(event.data)
            .then((items) => respond({ ok: true, items }))
            .catch((error) => respond({
                ok: false,
                error: error && error.message || '页面媒体解析失败',
            }));
    });
})();
