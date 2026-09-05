'use strict';

(() => {
    const core = globalThis.PotPlayerMediaAdapterCore;
    if (!core) throw new Error('Emby 适配器缺少共享核心');

    core.register({
        id: 'emby',
        serverPath: '/emby',
        streamPath: '/emby/videos',
        matchesHint: (hint) => /emby/i.test(hint) && !/jellyfin/i.test(hint),
    });
})();