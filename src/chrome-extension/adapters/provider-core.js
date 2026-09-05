'use strict';

(() => {
    const page = window;
    const adapters = new Map();
    const VIDEO_TYPES = new Set([
        'movie',
        'episode',
        'video',
        'musicvideo',
        'trailer',
        'homevideo',
        'adultvideo',
        'program',
        'channelvideo',
    ]);
    const CONTAINER_TYPES = new Set(['series', 'season']);
    const DEFAULT_FIELDS = 'MediaSources,MediaStreams,Path,Overview,UserData';
    const DEFAULT_MAX_ITEMS = 1024;

    function register(adapter) {
        if (!adapter || !adapter.id) throw new Error('媒体适配器缺少 id');
        adapters.set(String(adapter.id), Object.freeze(adapter));
    }

    function getServerInfo(api) {
        try {
            return api && (api._serverInfo || api.serverInfo) || {};
        } catch (_) {
            return {};
        }
    }

    function getServerAddress(api) {
        try {
            const info = getServerInfo(api);
            let address = api && (api._serverAddress || api.serverAddress || api.baseUrl);
            if (typeof address === 'function') address = address.call(api);
            if (!address) address = info.LocalAddress || info.RemoteAddress || page.location.origin;
            return String(address).replace(/\/+$/, '');
        } catch (_) {
            return String(page.location.origin).replace(/\/+$/, '');
        }
    }

    function getAccessToken(api) {
        try {
            if (api && typeof api.accessToken === 'function') return api.accessToken() || '';
            const info = getServerInfo(api);
            return info.AccessToken || '';
        } catch (_) {
            return '';
        }
    }

    function makeApiUrl(api, relativePath, adapter) {
        return makeServerUrl(api, relativePath, adapter);
    }

    function getProviderHint(api) {
        const info = getServerInfo(api);
        return [
            page.location.hostname,
            page.location.pathname,
            info.ProductName,
            info.ServerName,
            info.ServerVersion,
            info.LocalAddress,
            info.RemoteAddress,
            getServerAddress(api),
        ].filter(Boolean).join(' ').toLowerCase();
    }

    function resolve(preferredId, api) {
        if (preferredId && adapters.has(String(preferredId))) return adapters.get(String(preferredId));
        const hint = getProviderHint(api);
        for (const adapter of adapters.values()) {
            if (typeof adapter.matchesHint === 'function' && adapter.matchesHint(hint)) return adapter;
        }
        return adapters.get('emby') || adapters.values().next().value || null;
    }

    function itemType(item) {
        return String(item && item.Type || '').replace(/\s+/g, '').toLowerCase();
    }

    function isVideoItem(item) {
        return Boolean(item && VIDEO_TYPES.has(itemType(item)));
    }

    function isContainerItem(item) {
        return Boolean(item && CONTAINER_TYPES.has(itemType(item)));
    }

    function itemFields() {
        return DEFAULT_FIELDS;
    }

    async function getItem(api, userId, itemId) {
        if (!api || typeof api.getItem !== 'function') throw new Error('当前页面 API 不支持读取媒体信息');
        return await api.getItem(userId, itemId);
    }

    async function getMediaSources(api, userId, item) {
        if (Array.isArray(item && item.MediaSources) && item.MediaSources.length) return item.MediaSources;
        if (!api || typeof api.getPlaybackInfo !== 'function') return [];
        const result = await api.getPlaybackInfo(item.Id, {
            UserId: userId,
            StartTimeTicks: item.UserData && item.UserData.PlaybackPositionTicks || 0,
            IsPlayback: true,
            AutoOpenLiveStream: true,
            EnableDirectPlay: true,
            EnableDirectStream: true,
            EnableTranscoding: true,
        });
        return result && Array.isArray(result.MediaSources) ? result.MediaSources : [];
    }

    async function getAllItems(api, userId, options, maxItems = DEFAULT_MAX_ITEMS) {
        if (!api || typeof api.getItems !== 'function') throw new Error('当前页面 API 不支持读取播放列表');
        const limit = Math.max(1, Number(maxItems) || DEFAULT_MAX_ITEMS);
        const all = [];
        const pageSize = 500;
        let startIndex = 0;
        let total = Number.POSITIVE_INFINITY;

        while (all.length < limit + 1) {
            const requestLimit = Math.min(pageSize, limit + 1 - all.length);
            const result = await api.getItems(userId, {
                ...options,
                StartIndex: startIndex,
                Limit: requestLimit,
            });
            const items = result && Array.isArray(result.Items) ? result.Items : [];
            if (!items.length) break;

            const previousStartIndex = startIndex;
            all.push(...items);
            startIndex += items.length;
            const reportedTotal = Number(result.TotalRecordCount);
            if (Number.isFinite(reportedTotal)) total = reportedTotal;
            if (startIndex <= previousStartIndex || startIndex >= total) break;
            if (items.length < requestLimit && !Number.isFinite(total)) break;
        }
        return all;
    }

    async function getEpisodesEndpoint(api, userId, parentId, maxItems) {
        if (!api || typeof api.getEpisodes !== 'function') return [];
        try {
            const result = await api.getEpisodes(parentId, {
                UserId: userId,
                StartIndex: 0,
                Limit: Math.max(1, Number(maxItems) || DEFAULT_MAX_ITEMS),
                Fields: itemFields(),
                SortBy: 'ParentIndexNumber,IndexNumber,SortName',
                SortOrder: 'Ascending',
            });
            if (Array.isArray(result)) return result;
            return result && Array.isArray(result.Items) ? result.Items : [];
        } catch (_) {
            return [];
        }
    }

    function sortEpisodes(items) {
        return items.slice().sort((left, right) => {
            const leftSeason = Number(left && left.ParentIndexNumber);
            const rightSeason = Number(right && right.ParentIndexNumber);
            if (Number.isFinite(leftSeason) && Number.isFinite(rightSeason) && leftSeason !== rightSeason) {
                return leftSeason - rightSeason;
            }
            const leftIndex = Number(left && left.IndexNumber);
            const rightIndex = Number(right && right.IndexNumber);
            if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex) && leftIndex !== rightIndex) {
                return leftIndex - rightIndex;
            }
            return String(left && (left.SortName || left.Name) || '')
                .localeCompare(String(right && (right.SortName || right.Name) || ''));
        });
    }

    async function listEpisodes(api, userId, container, maxItems = DEFAULT_MAX_ITEMS) {
        if (!container || !isContainerItem(container)) return [];
        const type = itemType(container);
        const directOptions = {
            ParentId: container.Id,
            Recursive: type === 'series',
            IncludeItemTypes: 'Episode',
            SortBy: 'ParentIndexNumber,IndexNumber,SortName',
            SortOrder: 'Ascending',
            Fields: itemFields(),
        };

        let episodes = [];
        if (api && typeof api.getItems === 'function') {
            try {
                episodes = await getAllItems(api, userId, directOptions, maxItems);
            } catch (_) {
                episodes = [];
            }
        }
        episodes = episodes.filter(isVideoItem);
        if (episodes.length) return sortEpisodes(episodes);

        episodes = (await getEpisodesEndpoint(api, userId, container.Id, maxItems)).filter(isVideoItem);
        if (episodes.length) return sortEpisodes(episodes);

        if (type !== 'series' || !api || typeof api.getItems !== 'function') return [];
        let seasons = [];
        try {
            seasons = await getAllItems(api, userId, {
                ParentId: container.Id,
                Recursive: false,
                IncludeItemTypes: 'Season',
                SortBy: 'IndexNumber,SortName',
                SortOrder: 'Ascending',
                Fields: itemFields(),
            }, maxItems);
        } catch (_) {
            seasons = [];
        }

        const flattened = [];
        for (const season of seasons.filter((value) => itemType(value) === 'season')) {
            const remaining = Math.max(1, maxItems - flattened.length);
            let seasonEpisodes = [];
            try {
                seasonEpisodes = await getAllItems(api, userId, {
                    ParentId: season.Id,
                    Recursive: false,
                    IncludeItemTypes: 'Episode',
                    SortBy: 'IndexNumber,SortName',
                    SortOrder: 'Ascending',
                    Fields: itemFields(),
                }, remaining);
            } catch (_) {
                seasonEpisodes = [];
            }
            if (!seasonEpisodes.length) seasonEpisodes = await getEpisodesEndpoint(api, userId, season.Id, remaining);
            flattened.push(...seasonEpisodes.filter(isVideoItem));
            if (flattened.length > maxItems) break;
        }
        return sortEpisodes(flattened);
    }

    async function getNextUpEpisodes(api, userId, seriesId) {
        if (!api || typeof api.getNextUpEpisodes !== 'function') return [];
        try {
            const result = await api.getNextUpEpisodes({
                SeriesId: seriesId,
                UserId: userId,
                Limit: 1,
                Fields: itemFields(),
            });
            const items = Array.isArray(result) ? result : result && result.Items;
            return Array.isArray(items) ? items.filter(isVideoItem) : [];
        } catch (_) {
            return [];
        }
    }

    async function getSingleCandidates(api, userId, item, maxItems = DEFAULT_MAX_ITEMS) {
        if (!item) return [];
        if (!isContainerItem(item)) return [item];

        const candidates = [];
        if (itemType(item) === 'series') {
            candidates.push(...await getNextUpEpisodes(api, userId, item.Id));
        }
        candidates.push(...await listEpisodes(api, userId, item, maxItems));

        const seen = new Set();
        return candidates.filter((candidate) => {
            if (!isVideoItem(candidate) || !candidate.Id || seen.has(candidate.Id)) return false;
            seen.add(candidate.Id);
            return true;
        });
    }

    async function getPlaylistItems(api, userId, context, maxItems = DEFAULT_MAX_ITEMS) {
        let current = null;
        if (context && context.itemId) {
            try {
                current = await getItem(api, userId, context.itemId);
            } catch (_) {
                current = null;
            }
        }

        if (current && isContainerItem(current)) {
            const episodes = await listEpisodes(api, userId, current, maxItems);
            if (episodes.length) return episodes;
        }

        let parentId = context && context.parentId || '';
        if (!parentId && current) parentId = current.SeriesId || current.ParentId || '';
        if (!parentId) throw new Error('未找到当前目录');

        try {
            const parent = await getItem(api, userId, parentId);
            if (parent && isContainerItem(parent)) {
                const episodes = await listEpisodes(api, userId, parent, maxItems);
                if (episodes.length) return episodes;
            }
        } catch (_) {
            // parentId 也可能是普通媒体库目录，继续按目录查询。
        }

        const common = {
            ParentId: parentId,
            Recursive: false,
            IncludeItemTypes: 'Movie,Episode,Video,MusicVideo,Trailer,HomeVideo,AdultVideo,Program,ChannelVideo',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            Fields: itemFields(),
        };
        let items = await getAllItems(api, userId, common, maxItems);
        items = items.filter(isVideoItem);
        if (!items.length) throw new Error('当前目录没有可播放的视频');
        return sortEpisodes(items);
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

    function makeServerUrl(api, relativePath, adapter) {
        const base = new URL(getServerAddress(api) + '/', page.location.origin);
        let basePath = base.pathname.replace(/\/+$/, '');
        let path = '/' + String(relativePath || '').replace(/^\/+/, '');
        const serverPath = String(adapter.serverPath || '').replace(/\/+$/, '').toLowerCase();
        if (serverPath && basePath.toLowerCase().endsWith(serverPath)
            && path.toLowerCase().startsWith(serverPath + '/')) {
            path = path.slice(serverPath.length);
        }
        base.pathname = (basePath + path).replace(/\/+/g, '/');
        return base;
    }

    function finiteTicks(value) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
    }

    function playbackPositionTicks(item) {
        const userData = item && item.UserData || {};
        return finiteTicks(
            userData.PlaybackPositionTicks
            || userData.playbackPositionTicks
            || item && item.PlaybackPositionTicks
            || item && item.playbackPositionTicks,
        );
    }

    function runtimeTicks(item, source) {
        return finiteTicks(
            item && (item.RunTimeTicks || item.RuntimeTicks || item.runtimeTicks)
            || source && (source.RunTimeTicks || source.RuntimeTicks || source.runtimeTicks),
        );
    }

    function withStreamStartTime(url, startPositionTicks) {
        const endpoint = new URL(url, page.location.origin);
        if (startPositionTicks > 0) endpoint.searchParams.set('StartTimeTicks', String(startPositionTicks));
        return endpoint.href;
    }

    function buildStreamUrl(api, item, source, adapter, options = {}) {
        if (!item || !item.Id) return '';
        const token = getAccessToken(api);
        const base = getServerAddress(api);
        const mediaSourceId = source && (source.Id || source.MediaSourceId);
        const streamUrl = source && (source.DirectStreamUrl || source.directStreamUrl);
        const includeStart = options.includeStreamStartTime === true && options.resumePlayback !== false;
        const startPositionTicks = includeStart ? playbackPositionTicks(item) : 0;
        if (streamUrl) {
            const directUrl = addAccessToken(streamUrl, token, base);
            return startPositionTicks > 0
                ? withStreamStartTime(directUrl, startPositionTicks)
                : directUrl;
        }

        const endpoint = makeServerUrl(
            api,
            adapter.streamPath + '/' + encodeURIComponent(item.Id) + '/stream.' + streamExtension(source, item),
            adapter,
        );
        endpoint.searchParams.set('Static', 'true');
        if (token) endpoint.searchParams.set('api_key', token);
        if (mediaSourceId) endpoint.searchParams.set('MediaSourceId', mediaSourceId);
        if (startPositionTicks > 0) endpoint.searchParams.set('StartTimeTicks', String(startPositionTicks));
        return endpoint.href;
    }

    function buildEntry(api, item, source, adapter, options = {}) {
        const url = buildStreamUrl(api, item, source, adapter, options);
        if (!url) return null;
        const mediaSourceId = source && (source.Id || source.MediaSourceId);
        const positionTicks = options.resumePlayback === false ? 0 : playbackPositionTicks(item);
        return {
            url,
            title: itemTitle(item, source),
            itemId: String(item.Id),
            mediaSourceId: mediaSourceId ? String(mediaSourceId) : '',
            startPositionTicks: positionTicks,
            runtimeTicks: runtimeTicks(item, source),
        };
    }

    function itemTitle(item, source) {
        const path = source && source.Path || item && item.Path || '';
        const basename = String(path).split(/[\\/]/).pop();
        return item && (item.Name || item.SeriesName) || basename || 'Emby/Jellyfin video';
    }

    globalThis.PotPlayerMediaAdapterCore = Object.freeze({
        DEFAULT_FIELDS,
        VIDEO_TYPES,
        register,
        resolve,
        getItem,
        getMediaSources,
        getAllItems,
        getSingleCandidates,
        getPlaylistItems,
        getAccessToken,
        getServerAddress,
        makeApiUrl,
        buildStreamUrl,
        buildEntry,
        playbackPositionTicks,
        runtimeTicks,
        itemTitle,
        isVideoItem,
        isContainerItem,
        itemType,
    });
})();
