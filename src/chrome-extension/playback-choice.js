'use strict';

(() => {
    const BUTTON_SELECTOR = '[data-potplayer-choice]';
    const CONTROL_SELECTOR = [
        '.detailButtons button', '.detailButtons a', '.detailButtons [role="button"]',
        '.mainDetailButtons button', '.mainDetailButtons a',
        '.itemsViewSettingsContainer button', '.itemsViewSettingsContainer a',
    ].join(',');

    function getDefaultDestination(settings) {
        const configured = settings && settings.defaultPlayer;
        if (configured === 'web' || configured === 'potplayer') return configured;
        return settings && settings.enabled === false ? 'web' : 'potplayer';
    }

    function getAlternateDestination(settings) {
        return getDefaultDestination(settings) === 'potplayer' ? 'web' : 'potplayer';
    }
    function create({ getSettings, getMode }) {
        const buttons = new Map();
        const originals = new WeakMap();
        let scheduled = false;

        function isVisible(target) {
            if (!target.isConnected || target.closest('[hidden], .hide, .hidden, [aria-hidden="true"]')) return false;
            const style = window.getComputedStyle(target);
            return style.display !== 'none' && style.visibility !== 'hidden'
                && target.getClientRects().length > 0;
        }

        function syncButtons() {
            scheduled = false;
            const settings = getSettings();
            const allowed = settings && settings.allowedOrigins.includes(location.origin);
            const controls = allowed
                ? [...document.querySelectorAll(CONTROL_SELECTOR)]
                    .filter((target) => !target.matches(BUTTON_SELECTOR) && getMode(target) && isVisible(target))
                : [];
            const active = new Set(controls);
            for (const [target, button] of buttons) {
                if (!active.has(target) || !button.isConnected) {
                    button.remove();
                    buttons.delete(target);
                    originals.delete(button);
                }
            }

            for (const target of controls) {
                let button = buttons.get(target);
                if (!button) {
                    button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'potplayer-choice-button';
                    button.setAttribute('data-potplayer-choice', '');
                    buttons.set(target, button);
                    originals.set(button, target);
                }
                const destination = getAlternateDestination(settings);
                const player = destination === 'web' ? '网页' : 'PotPlayer';
                const mode = getMode(target);
                const verb = mode === 'random' ? '随机播放' : mode === 'all' ? '播放全部' : '播放';
                const label = '在' + player + '中' + verb;
                const title = '仅本次使用' + player + '，不改变默认播放方式';
                if (button.textContent !== label) button.textContent = label;
                if (button.title !== title) button.title = title;
                if (button.getAttribute('data-destination') !== destination) {
                    button.setAttribute('data-destination', destination);
                }
                const height = Math.round(target.getBoundingClientRect().height) + 'px';
                if (button.style.getPropertyValue('--potplayer-choice-height') !== height) {
                    button.style.setProperty('--potplayer-choice-height', height);
                }
                if (target.nextElementSibling !== button) target.after(button);
            }
        }

        function refresh() {
            if (scheduled) return;
            scheduled = true;
            window.requestAnimationFrame(syncButtons);
        }

        // Emby/Jellyfin 都会复用或替换详情页节点，不能只在首次加载时添加按钮。
        const observer = new MutationObserver(refresh);
        observer.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden', 'aria-disabled',
                'title', 'aria-label', 'data-mode'],
        });
        window.addEventListener('hashchange', refresh);
        window.addEventListener('popstate', refresh);
        window.addEventListener('resize', refresh);
        refresh();

        return Object.freeze({
            refresh,
            getSelection(element) {
                const button = element?.closest(BUTTON_SELECTOR);
                const target = button && originals.get(button);
                if (!target || !target.isConnected || !isVisible(target) || !getMode(target)) return null;
                return {
                    target,
                    destination: getAlternateDestination(getSettings()),
                };
            },
        });
    }

    globalThis.PotPlayerPlaybackChoice = Object.freeze({ create });
})();
