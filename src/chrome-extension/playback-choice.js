'use strict';

(() => {
    const GROUP_SELECTOR = '[data-potplayer-choice-group]';
    const BUTTON_SELECTOR = '[data-potplayer-choice]';
    const DESTINATION_ATTRIBUTE = 'data-potplayer-destination';
    const ORIGINAL_ATTRIBUTE = 'data-potplayer-choice-original';
    const ORIGINAL_SELECTOR = `[${ORIGINAL_ATTRIBUTE}]`;
    const CONTROL_SELECTOR = [
        '.detailButtons button', '.detailButtons a', '.detailButtons [role="button"]',
        '.mainDetailButtons button', '.mainDetailButtons a',
        '.itemsViewSettingsContainer button', '.itemsViewSettingsContainer a',
    ].join(',');

    function create({ getSettings, getMode }) {
        const groups = new Map();
        const originals = new WeakMap();
        let scheduled = false;

        function isVisible(target) {
            if (!target.isConnected || target.closest('[hidden], .hide, .hidden, [aria-hidden="true"]')) return false;
            const style = window.getComputedStyle(target);
            return style.display !== 'none' && style.visibility !== 'hidden'
                && target.getClientRects().length > 0;
        }

        function createButton(destination) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'potplayer-choice-button';
            button.setAttribute('data-potplayer-choice', '');
            button.setAttribute(DESTINATION_ATTRIBUTE, destination);
            button.setAttribute('data-destination', destination);
            return button;
        }

        function getVerb(mode) {
            if (mode === 'random') return '随机播放';
            if (mode === 'all') return '播放全部';
            return '播放';
        }

        function updateButton(button, destination, mode) {
            const player = destination === 'web' ? '网页' : 'PotPlayer';
            const label = '在' + player + '中' + getVerb(mode);
            button.textContent = label;
            button.title = label;
            button.setAttribute('aria-label', label);
        }

        function restoreOriginal(entry) {
            const target = entry.target;
            if (!target.isConnected) return;
            target.hidden = entry.originalHidden;
            if (entry.originalAriaHidden === null) target.removeAttribute('aria-hidden');
            else target.setAttribute('aria-hidden', entry.originalAriaHidden);
            target.removeAttribute(ORIGINAL_ATTRIBUTE);
        }

        function removeGroup(target, entry) {
            entry.group.remove();
            restoreOriginal(entry);
            groups.delete(target);
        }

        function syncButtons() {
            scheduled = false;
            const settings = getSettings();
            const allowed = Boolean(settings && Array.isArray(settings.allowedOrigins)
                && settings.allowedOrigins.includes(location.origin));
            const controls = allowed
                ? [...document.querySelectorAll(CONTROL_SELECTOR)].filter((target) => (
                    !target.matches(BUTTON_SELECTOR)
                    && !target.closest(GROUP_SELECTOR)
                    && getMode(target)
                    && (target.matches(ORIGINAL_SELECTOR) || isVisible(target))
                ))
                : [];
            const active = new Set(controls);

            for (const [target, entry] of groups) {
                if (!active.has(target) || !entry.group.isConnected) removeGroup(target, entry);
            }

            for (const target of controls) {
                let entry = groups.get(target);
                if (!entry) {
                    const group = document.createElement('span');
                    group.className = 'potplayer-choice-group';
                    group.setAttribute('data-potplayer-choice-group', '');
                    group.setAttribute('role', 'group');
                    group.setAttribute('aria-label', '选择播放方式');
                    const webButton = createButton('web');
                    const potPlayerButton = createButton('potplayer');
                    group.append(webButton, potPlayerButton);
                    entry = {
                        target,
                        group,
                        webButton,
                        potPlayerButton,
                        originalHidden: target.hidden,
                        originalAriaHidden: target.getAttribute('aria-hidden'),
                    };
                    groups.set(target, entry);
                    originals.set(webButton, target);
                    originals.set(potPlayerButton, target);
                }

                const mode = getMode(target);
                updateButton(entry.webButton, 'web', mode);
                updateButton(entry.potPlayerButton, 'potplayer', mode);
                target.hidden = true;
                target.setAttribute('aria-hidden', 'true');
                target.setAttribute(ORIGINAL_ATTRIBUTE, '');
                if (target.nextElementSibling !== entry.group) target.after(entry.group);
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
                const destination = button && button.getAttribute(DESTINATION_ATTRIBUTE);
                if (!button || !target || !target.isConnected
                    || (destination !== 'web' && destination !== 'potplayer') || !getMode(target)) return null;
                return { target, destination };
            },
        });
    }

    globalThis.PotPlayerPlaybackChoice = Object.freeze({ create });
})();
