'use strict';

const settingsApi = globalThis.PotPlayerSettings;
const $ = (id) => document.getElementById(id);
const staticOrigins = new Set(settingsApi.DEFAULTS.allowedOrigins);
let origins = [];

function setStatus(message, error = false) {
    const element = $('status');
    element.textContent = message;
    element.classList.toggle('error', error);
}

function originPattern(origin) {
    return `${origin}/*`;
}

function requestOriginsPermission(values) {
    const patterns = values.map(originPattern);
    if (!patterns.length) return Promise.resolve(true);
    return new Promise((resolve) => {
        chrome.permissions.request({ origins: patterns }, (granted) => resolve(granted === true));
    });
}

function hasOriginPermission(origin) {
    return new Promise((resolve) => {
        chrome.permissions.contains({ origins: [originPattern(origin)] }, (result) => resolve(result === true));
    });
}

function renderOrigins() {
    const list = $('origin-list');
    list.replaceChildren();
    if (!origins.length) {
        const empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = '当前没有启用站点';
        list.append(empty);
        return;
    }
    for (const origin of origins) {
        const row = document.createElement('div');
        row.className = 'origin-row';
        const value = document.createElement('span');
        value.className = 'origin-value';
        value.title = origin;
        value.textContent = origin;
        row.append(value);
        if (staticOrigins.has(origin)) {
            const badge = document.createElement('span');
            badge.className = 'origin-badge';
            badge.textContent = '内置';
            row.append(badge);
        }
        const remove = document.createElement('button');
        remove.className = 'origin-remove';
        remove.type = 'button';
        remove.textContent = '移除';
        remove.addEventListener('click', () => {
            origins = origins.filter((item) => item !== origin);
            renderOrigins();
            setStatus('已修改，点击“保存设置”生效');
        });
        row.append(remove);
        list.append(row);
    }
}

function fillForm(values) {
    $('enabled').checked = values.enabled;
    $('maxPlaylistItems').value = values.maxPlaylistItems;
    $('mediaSourceConcurrency').value = values.mediaSourceConcurrency;
    $('requestTimeoutSeconds').value = values.requestTimeoutSeconds;
    $('skipUnavailable').checked = values.skipUnavailable;
    $('fallbackToBrowser').checked = values.fallbackToBrowser;
    $('resumePlayback').checked = values.resumePlayback;
    $('syncPlayback').checked = values.syncPlayback;
    origins = values.allowedOrigins.slice();
    renderOrigins();
}

function readForm() {
    return settingsApi.normalize({
        enabled: $('enabled').checked,
        maxPlaylistItems: $('maxPlaylistItems').value,
        mediaSourceConcurrency: $('mediaSourceConcurrency').value,
        requestTimeoutSeconds: $('requestTimeoutSeconds').value,
        skipUnavailable: $('skipUnavailable').checked,
        fallbackToBrowser: $('fallbackToBrowser').checked,
        resumePlayback: $('resumePlayback').checked,
        syncPlayback: $('syncPlayback').checked,
        allowedOrigins: origins,
    });
}

async function saveSettings() {
    const saveButton = $('save');
    saveButton.disabled = true;
    setStatus('正在保存…');
    let permissionWarning = false;
    try {
        let values = readForm();
        const extraOrigins = values.allowedOrigins.filter((origin) => !staticOrigins.has(origin));
        if (extraOrigins.length) {
            const granted = await requestOriginsPermission(extraOrigins);
            if (!granted) {
                permissionWarning = true;
                const permitted = [];
                for (const origin of extraOrigins) {
                    if (await hasOriginPermission(origin)) permitted.push(origin);
                }
                values = { ...values, allowedOrigins: values.allowedOrigins.filter((origin) => staticOrigins.has(origin) || permitted.includes(origin)) };
                origins = values.allowedOrigins.slice();
                renderOrigins();
            }
        }
        await new Promise((resolve, reject) => {
            chrome.storage.local.set(values, () => {
                const error = chrome.runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve();
            });
        });
        setStatus(permissionWarning
            ? '部分站点权限未获批准；其余设置已保存'
            : '已保存；新增或移除站点后请刷新网页标签页', permissionWarning);
    } catch (error) {
        setStatus(error && error.message || '保存失败', true);
    } finally {
        saveButton.disabled = false;
    }
}

$('version').textContent = `v${chrome.runtime.getManifest().version}`;
$('enabled').addEventListener('change', () => {
    const enabled = $('enabled').checked;
    chrome.storage.local.set({ enabled }, () => {
        const error = chrome.runtime.lastError;
        setStatus(error ? '启用状态保存失败' : (enabled ? '默认使用 PotPlayer' : '默认使用网页；仍可临时选择 PotPlayer'));
    });
});
$('add-origin').addEventListener('click', () => {
    const value = settingsApi.normalizeOrigin($('new-origin').value);
    if (!value) {
        setStatus('请输入有效的 http 或 https 网址', true);
        return;
    }
    if (!origins.includes(value)) origins.push(value);
    $('new-origin').value = '';
    renderOrigins();
    setStatus('已加入列表，点击“保存设置”后请求权限');
});
$('new-origin').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('add-origin').click();
});
$('save').addEventListener('click', () => void saveSettings());
$('reset').addEventListener('click', () => {
    fillForm(settingsApi.normalize(settingsApi.DEFAULTS));
    setStatus('已恢复默认值，点击“保存设置”确认');
});

chrome.storage.local.get(null, (values) => {
    fillForm(settingsApi.normalize(values));
    setStatus('');
});
