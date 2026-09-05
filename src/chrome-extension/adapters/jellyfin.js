'use strict';

(() => {
    const core = globalThis.PotPlayerMediaAdapterCore;
    if (!core) throw new Error('Jellyfin 适配器缺少共享核心');

    core.register({
        id: 'jellyfin',
        serverPath: '',
        streamPath: '/Videos',
        matchesHint: (hint) => /jellyfin/i.test(hint),
    });
})();