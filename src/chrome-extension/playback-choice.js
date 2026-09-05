'use strict';

(() => {
    const GROUP_SELECTOR = '[data-potplayer-choice-group]';
    const BUTTON_SELECTOR = '[data-potplayer-choice]';
    const DESTINATION_ATTRIBUTE = 'data-potplayer-destination';
    const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
    const CONTROL_SELECTOR = [
        '.detailButtons button', '.detailButtons a', '.detailButtons [role="button"]',
        '.mainDetailButtons button', '.mainDetailButtons a',
        '.itemsViewSettingsContainer button', '.itemsViewSettingsContainer a',
    ].join(',');

    function create({ getSettings, getMode, getProvider }) {
        const groups = new Map();
        const originals = new WeakMap();
        let scheduled = false;

        function isVisible(target) {
            if (!target.isConnected || target.closest('[hidden], .hide, .hidden, [aria-hidden="true"]')) return false;
            const style = window.getComputedStyle(target);
            return style.display !== 'none' && style.visibility !== 'hidden'
                && target.getClientRects().length > 0;
        }

        function createSvgElement(name) {
            return document.createElementNS(SVG_NAMESPACE, name);
        }

        function appendPath(svg, pathData) {
            const path = createSvgElement('path');
            path.setAttribute('d', pathData);
            path.setAttribute('fill', 'currentColor');
            svg.append(path);
        }

        function getIconKey(destination, provider) {
            if (destination === 'potplayer') return 'potplayer';
            return provider === 'jellyfin' ? 'jellyfin' : 'emby';
        }

        function createIcon(destination, provider) {
            const svg = createSvgElement('svg');
            const iconKey = getIconKey(destination, provider);
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('class', 'potplayer-choice-icon potplayer-choice-icon-' + iconKey);
            svg.setAttribute('aria-hidden', 'true');
            svg.setAttribute('focusable', 'false');
            if (iconKey === 'potplayer') {
                const circle = createSvgElement('circle');
                circle.setAttribute('cx', '12');
                circle.setAttribute('cy', '12');
                circle.setAttribute('r', '8.5');
                circle.setAttribute('fill', 'none');
                circle.setAttribute('stroke', 'currentColor');
                circle.setAttribute('stroke-width', '2');
                svg.append(circle);
                appendPath(svg, 'M10 8.25 16 12l-6 3.75z');
            } else if (iconKey === 'jellyfin') {
                appendPath(svg, 'M2.5 12c2.4-4.7 7.3-7.2 12.5-5.2L20.8 4l-1 5.6 2.7 2.4-2.7 2.4 1 5.6-5.8-2.8C9.8 19.2 4.9 16.7 2.5 12z');
                const eye = createSvgElement('circle');
                eye.setAttribute('cx', '10.2');
                eye.setAttribute('cy', '10.4');
                eye.setAttribute('r', '1');
                eye.setAttribute('fill', 'currentColor');
                svg.append(eye);
            } else {
                appendPath(svg, 'M5 4h14v3H8v3h9v3H8v4h11v3H5V4z');
            }
            return svg;
        }

        function createButton(destination) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'potplayer-choice-button';
            button.setAttribute('data-potplayer-choice', '');
            button.setAttribute(DESTINATION_ATTRIBUTE, destination);
            button.setAttribute('data-destination', destination);
            button.append(createIcon(destination, ''));
            return button;
        }

        function getVerb(mode) {
            if (mode === 'random') return '随机播放';
            if (mode === 'all') return '播放全部';
            return '播放';
        }

        function getWebPlayerLabel(provider) {
            if (provider === 'emby') return 'Emby';
            if (provider === 'jellyfin') return 'Jellyfin';
            return '网页';
        }

        function setAttributeIfChanged(target, name, value) {
            if (target.getAttribute(name) !== value) target.setAttribute(name, value);
        }

        function updateButton(button, destination, mode, provider) {
            const player = destination === 'web' ? getWebPlayerLabel(provider) : 'PotPlayer';
            const label = '在' + player + '中' + getVerb(mode);
            const iconKey = getIconKey(destination, provider);
            if (button.getAttribute('data-potplayer-icon') !== iconKey) {
                button.replaceChildren(createIcon(destination, provider));
                setAttributeIfChanged(button, 'data-potplayer-icon', iconKey);
            }
            setAttributeIfChanged(button, 'data-player', destination === 'web' ? 'web' : 'potplayer');
            setAttributeIfChanged(button, 'data-provider', destination === 'web' ? (provider || 'web') : 'potplayer');
            setAttributeIfChanged(button, 'title', label);
            setAttributeIfChanged(button, 'aria-label', label);
            setAttributeIfChanged(button, 'data-tooltip', label);
        }

        function removeGroup(target, entry) {
            entry.group.remove();
            groups.delete(target);
        }

        function syncButtons() {
            scheduled = false;
            const settings = getSettings();
            const provider = typeof getProvider === 'function' ? getProvider() : '';
            const allowed = Boolean(settings && Array.isArray(settings.allowedOrigins)
                && settings.allowedOrigins.includes(location.origin));
            const controls = allowed
                ? [...document.querySelectorAll(CONTROL_SELECTOR)].filter((target) => (
                    !target.matches(BUTTON_SELECTOR)
                    && !target.closest(GROUP_SELECTOR)
                    && getMode(target)
                    && isVisible(target)
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
                    };
                    groups.set(target, entry);
                    originals.set(webButton, target);
                    originals.set(potPlayerButton, target);
                }

                const mode = getMode(target);
                updateButton(entry.webButton, 'web', mode, provider);
                updateButton(entry.potPlayerButton, 'potplayer', mode, provider);
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
