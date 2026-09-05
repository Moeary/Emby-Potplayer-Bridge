'use strict';

(() => {
    const DEFAULTS = Object.freeze({
        enabled: true,
        defaultPlayer: 'potplayer',
        maxPlaylistItems: 1024,
        mediaSourceConcurrency: 6,
        requestTimeoutSeconds: 120,
        fallbackToBrowser: true,
        skipUnavailable: true,
        resumePlayback: true,
        syncPlayback: true,
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
        const defaultPlayer = readDefaultPlayer(source);
        return {
            defaultPlayer,
            enabled: defaultPlayer === 'potplayer',
            maxPlaylistItems: clampInteger(source.maxPlaylistItems, DEFAULTS.maxPlaylistItems, 1, 4096),
            mediaSourceConcurrency: clampInteger(source.mediaSourceConcurrency, DEFAULTS.mediaSourceConcurrency, 1, 12),
            requestTimeoutSeconds: clampInteger(source.requestTimeoutSeconds, DEFAULTS.requestTimeoutSeconds, 15, 300),
            fallbackToBrowser: source.fallbackToBrowser !== false,
            skipUnavailable: source.skipUnavailable !== false,
            resumePlayback: source.resumePlayback !== false,
            syncPlayback: source.syncPlayback !== false,
            allowedOrigins,
        };
    }

    function readBoolean(value, fallback) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'on', 'potplayer'].includes(normalized)) return true;
            if (['false', '0', 'no', 'off', 'web'].includes(normalized)) return false;
        }
        return fallback;
    }

    function readDefaultPlayer(source) {
        const configured = String(source.defaultPlayer || '').trim().toLowerCase();
        if (configured === 'web' || configured === 'potplayer') return configured;
        return readBoolean(source.enabled, DEFAULTS.enabled) ? 'potplayer' : 'web';
    }

    globalThis.PotPlayerSettings = Object.freeze({ DEFAULTS, normalize, normalizeOrigin });
})();
