'use strict';

(() => {
    const DEFAULTS = Object.freeze({
        enabled: true,
        maxPlaylistItems: 1024,
        mediaSourceConcurrency: 6,
        requestTimeoutSeconds: 120,
        fallbackToBrowser: true,
        skipUnavailable: true,
        allowedOrigins: Object.freeze([
            'https://emby.moear.de',
            'https://jellyfin.moear.de',
        ]),
    });

    function clampInteger(value, fallback, min, max) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, Math.round(number)));
    }

    function normalizeOrigin(value) {
        let text = String(value || '').trim();
        if (!text) return '';
        if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `https://${text}`;
        try {
            const url = new URL(text);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
            return url.origin;
        } catch (_) {
            return '';
        }
    }

    function normalize(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const rawOrigins = Array.isArray(source.allowedOrigins)
            ? source.allowedOrigins
            : DEFAULTS.allowedOrigins;
        const allowedOrigins = [...new Set(rawOrigins.map(normalizeOrigin).filter(Boolean))];
        return {
            enabled: source.enabled !== false,
            maxPlaylistItems: clampInteger(source.maxPlaylistItems, DEFAULTS.maxPlaylistItems, 1, 4096),
            mediaSourceConcurrency: clampInteger(source.mediaSourceConcurrency, DEFAULTS.mediaSourceConcurrency, 1, 12),
            requestTimeoutSeconds: clampInteger(source.requestTimeoutSeconds, DEFAULTS.requestTimeoutSeconds, 15, 300),
            fallbackToBrowser: source.fallbackToBrowser !== false,
            skipUnavailable: source.skipUnavailable !== false,
            allowedOrigins,
        };
    }

    globalThis.PotPlayerSettings = Object.freeze({ DEFAULTS, normalize, normalizeOrigin });
})();
