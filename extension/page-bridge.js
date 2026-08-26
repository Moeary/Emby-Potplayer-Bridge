'use strict';

(() => {
    const PAGE_SOURCE = 'codex-emby-jellyfin-potplayer-page';
    const REQUEST_TYPE = 'codex-potplayer-request';
    const RESPONSE_TYPE = 'codex-potplayer-response';
    const page = window;
    const settingsApi = page.PotPlayerSettings;

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
        };
    }

    function getHashParams() {
        const hash = String(page.location.hash || '');
        const index = hash.indexOf('?');
        return index >= 0 ? new URLSearchParams(hash.slice(index + 1)) : new URLSearchParams();
    }

    function getApiClient(serverId) {
        try {
            if (page.ApiClient) return page.ApiClient;
            if (page.apiClient) return page.apiClient;
            const manager = page.ConnectionManager || page.connectionManager;
            if (manager && typeof manager.getApiClient === 'function') {
                return manager.getApiClient(serverId || undefined) || manager.getApiClient();
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
            if (api && (typeof api.getItem === 'function' || typeof api.getItems === 'function' || typeof api.getPlaybackInfo === 'function')) return api;
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

    function getServerAddress(api) {
        try {
            let address = api._serverAddress || api.serverAddress || api.baseUrl;
            if (typeof address === 'function') address = address.call(api);
            if (address) return String(address).replace(/\/$/, '');
        } catch (_) {
            // 使用页面来源作为回退。
        }
        return String(page.location.origin).replace(/\/$/, '');
    }

    function getAccessToken(api) {
        try {
            if (typeof api.accessToken === 'function') return api.accessToken() || '';
            if (api._serverInfo && api._serverInfo.AccessToken) return api._serverInfo.AccessToken;
        } catch (_) {
            // 不将令牌写入页面日志。
        }
        return '';
    }

    async function getItem(api, userId, itemId) {
        if (typeof api.getItem !== 'function') throw new Error('当前页面 API 不支持读取媒体信息');
        return await api.getItem(userId, itemId);
    }

    async function getMediaSources(api, userId, item) {
        if (Array.isArray(item.MediaSources) && item.MediaSources.length) return item.MediaSources;
        if (typeof api.getPlaybackInfo === 'function') {
            const result = await api.getPlaybackInfo(item.Id, {
                UserId: userId,
                StartTimeTicks: item.UserData && item.UserData.PlaybackPositionTicks || 0,
                IsPlayback: true,
                AutoOpenLiveStream: true,
                EnableDirectPlay: true,
                EnableDirectStream: true,
                EnableTranscoding: true,
            });
            if (result && Array.isArray(result.MediaSources)) return result.MediaSources;
        }
        return [];
    }

    async function getAllItems(api, userId, options, maxItems) {
        if (typeof api.getItems !== 'function') throw new Error('当前页面 API 不支持读取播放列表');
        const all = [];
        const pageSize = 500;
        let startIndex = 0;
        let total = Number.POSITIVE_INFINITY;
        // 多取 1 项，用于识别“超过上限”，同时避免无界分页请求。
        while (all.length < maxItems + 1) {
            const limit = Math.min(pageSize, maxItems + 1 - all.length);
            const result = await api.getItems(userId, { ...options, StartIndex: startIndex, Limit: limit });
            const items = result && Array.isArray(result.Items) ? result.Items : [];
            if (!items.length) break;
            all.push(...items);
            startIndex += items.length;
            const reportedTotal = Number(result.TotalRecordCount);
            if (Number.isFinite(reportedTotal)) total = reportedTotal;
            if (items.length < pageSize || startIndex >= total) break;
        }
        return all;
    }

    function isVideoItem(item) {
        return Boolean(item && ['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer', 'HomeVideo', 'AdultVideo', 'Program', 'ChannelVideo'].includes(item.Type));
    }

    async function getPlaylistItems(api, userId, context, settings) {
        let parentId = context.parentId;
        if (!parentId && context.itemId) {
            const current = await getItem(api, userId, context.itemId);
            parentId = current && (current.ParentId || current.SeriesId || '');
        }
        if (!parentId) throw new Error('未找到当前目录');

        const common = {
            ParentId: parentId,
            Recursive: false,
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            Fields: 'MediaSources,MediaStreams,Path,Overview,UserData',
        };
        const includeItemTypes = 'Movie,Episode,Video,MusicVideo,Trailer,HomeVideo,AdultVideo,Program,ChannelVideo';
        let items = await getAllItems(api, userId, { ...common, IncludeItemTypes: includeItemTypes }, settings.maxPlaylistItems);
        if (!items.length) items = await getAllItems(api, userId, common, settings.maxPlaylistItems);
        items = items.filter(isVideoItem);
        if (!items.length) throw new Error('当前目录没有可播放的视频');
        if (items.length > settings.maxPlaylistItems) {
            throw new Error(`当前目录有 ${items.length} 项，超过当前上限 ${settings.maxPlaylistItems} 项`);
        }
        return items;
    }

    function shuffle(items) {
        const result = items.slice();
        for (let i = result.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
    }

    function streamExtension(source, item) {
        const raw = source && (source.Container || source.Format);
        if (raw) return String(raw).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
        const path = source && source.Path || item && item.Path || '';
        const match = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(path);
        return match ? match[1].toLowerCase() : 'mp4';
    }

    function addAccessToken(url, token, base) {
        const parsed = new URL(url, base);
        if (token && !parsed.searchParams.has('api_key')) parsed.searchParams.set('api_key', token);
        return parsed.href;
    }

    function buildStreamUrl(api, item, source) {
        const base = getServerAddress(api);
        const token = getAccessToken(api);
        const mediaSourceId = source && (source.Id || source.MediaSourceId);
        let streamUrl = source && source.DirectStreamUrl;
        if (!streamUrl) {
            const query = new URLSearchParams({ Static: 'true' });
            if (token) query.set('api_key', token);
            if (mediaSourceId) query.set('MediaSourceId', mediaSourceId);
            streamUrl = `${base}/emby/videos/${encodeURIComponent(item.Id)}/stream.${streamExtension(source, item)}?${query.toString()}`;
        } else {
            streamUrl = addAccessToken(streamUrl, token, base);
        }
        return streamUrl;
    }

    function itemTitle(item, source) {
        const path = source && source.Path || item && item.Path || '';
        const basename = String(path).split(/[\\/]/).pop();
        return item && (item.Name || item.SeriesName) || basename || 'Emby/Jellyfin video';
    }

    async function buildEntries(api, userId, items, settings) {
        const entries = new Array(items.length);
        let skipped = 0;
        let nextIndex = 0;

        async function worker() {
            while (true) {
                const index = nextIndex++;
                if (index >= items.length) return;
                const item = items[index];
                try {
                    const source = (await getMediaSources(api, userId, item))[0];
                    if (!source) {
                        skipped += 1;
                        continue;
                    }
                    const url = buildStreamUrl(api, item, source);
                    if (url) entries[index] = { url, title: itemTitle(item, source) };
                    else skipped += 1;
                } catch (_) {
                    // 跳过没有可用媒体源的项目。
                    skipped += 1;
                }
            }
        }

        const workerCount = Math.min(settings.mediaSourceConcurrency, items.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        const playableEntries = entries.filter(Boolean);
        if (!playableEntries.length) throw new Error('没有生成可播放的视频地址');
        if (!settings.skipUnavailable && skipped) {
            throw new Error(`有 ${skipped} 项没有可用媒体源，已按设置停止播放`);
        }
        return playableEntries;
    }

    async function resolveSingle(api, userId, context) {
        let item = await getItem(api, userId, context.itemId);
        if (item && ['Series', 'Season'].includes(item.Type)) {
            const seriesId = item.Type === 'Series' ? item.Id : (item.SeriesId || item.Id);
            if (typeof api.getNextUpEpisodes === 'function') {
                try {
                    const next = await api.getNextUpEpisodes({ SeriesId: seriesId, UserId: userId, Limit: 1, Fields: 'MediaSources,MediaStreams,Path,Overview' });
                    if (next && next.Items && next.Items[0]) item = next.Items[0];
                } catch (_) { /* fallback below */ }
            }
        }
        const source = (await getMediaSources(api, userId, item))[0];
        if (!source) throw new Error('当前媒体没有可用视频源');
        return [{ url: buildStreamUrl(api, item, source), title: itemTitle(item, source) }];
    }

    async function handleRequest(data) {
        const context = data.context || {};
        const settings = normalizeSettings(data.settings);
        const api = await waitForApiClient(context.serverId, settings.requestTimeoutSeconds * 1000);
        if (!api) throw new Error('未找到页面 API');
        const userId = await getUserId(api);
        if (!userId) throw new Error('未找到当前登录用户');
        if (data.mode === 'single') return resolveSingle(api, userId, context);
        let items = await getPlaylistItems(api, userId, context, settings);
        if (data.mode === 'random') items = shuffle(items);
        return buildEntries(api, userId, items, settings);
    }

    page.addEventListener('message', (event) => {
        if (event.source !== page || !event.data || event.data.source !== PAGE_SOURCE || event.data.type !== REQUEST_TYPE) return;
        void handleRequest(event.data)
            .then((items) => page.postMessage({ source: PAGE_SOURCE, type: RESPONSE_TYPE, requestId: event.data.requestId, mode: event.data.mode, ok: true, items }, '*'))
            .catch((error) => page.postMessage({ source: PAGE_SOURCE, type: RESPONSE_TYPE, requestId: event.data.requestId, mode: event.data.mode, ok: false, error: error && error.message || '页面媒体解析失败' }, '*'));
    });
})();
