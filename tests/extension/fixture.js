'use strict';

(() => {
    const PAGE_SOURCE = 'codex-emby-jellyfin-potplayer-page';
    const values = { enabled: true, allowedOrigins: [location.origin], syncPlayback: false };
    const changes = [];
    const requests = [];
    const nativeCalls = [];
    let webCalls = 0;
    let holdResponses = false;
    let holdNative = false;
    let heldNativeCallback = null;

    function showActivity() {
        document.getElementById('activity').textContent =
            '默认：' + (values.enabled ? 'PotPlayer' : '网页') +
            ' · 网页播放 ' + webCalls + ' 次 · PotPlayer ' + nativeCalls.length + ' 次' +
            (nativeCalls.length ? '\n最近条目：' + nativeCalls.at(-1).items[0].itemId : '');
    }

    // 只模拟扩展运行环境，不会写入真实 Chrome 扩展设置。
    window.chrome = {
        storage: {
            local: {
                get(_keys, callback) { queueMicrotask(() => callback({ ...values })); },
                set() { throw new Error('一次性选择不得写入设置'); },
            },
            onChanged: { addListener(fn) { changes.push(fn); } },
        },
        runtime: {
            onMessage: { addListener() {} },
            sendMessage(message, callback) {
                nativeCalls.push(message.payload);
                showActivity();
                if (holdNative) heldNativeCallback = callback;
                else queueMicrotask(() => callback({ ok: true }));
            },
        },
    };

    function setDefaults(updates) {
        Object.assign(values, updates);
        changes.forEach((fn) => fn({}, 'local'));
        showActivity();
    }

    function respond(request) {
        window.postMessage({
            source: PAGE_SOURCE, type: 'codex-potplayer-response',
            requestId: request.requestId, mode: request.mode, ok: true,
            items: [{ itemId: request.context.itemId, title: 'episode', url: location.origin + '/video.mkv' }],
        }, '*');
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.data?.source !== PAGE_SOURCE
            || event.data.type !== 'codex-potplayer-request') return;
        requests.push(event.data);
        if (!holdResponses) respond(event.data);
    });

    // 模拟网页原有的冒泡事件处理；被插件拦截的点击不应到达这里。
    document.addEventListener('click', (event) => {
        const target = event.target.closest('.btnResume, .btnPlay, .btnShuffle');
        if (target) { webCalls += 1; showActivity(); }
    });

    // 等待消息队列和按钮更新的动画帧；固定毫秒数在繁忙的真实 Chrome 中不可靠。
    const settle = () => new Promise((resolve) => {
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 0);
    });
    const primary = () => document.querySelector('#detail-controls .btnResume');
    const alternate = () => document.querySelector('#detail-controls [data-potplayer-choice]');
    const assert = (condition, message) => { if (!condition) throw new Error(message); };

    window.addEventListener('DOMContentLoaded', () => {
        location.hash = '!/item?id=ep4&serverId=fixture';
        document.getElementById('default-player').addEventListener('change', (event) => {
            setDefaults({ enabled: event.target.value === 'potplayer' });
        });
        document.getElementById('run-tests').addEventListener('click', async (event) => {
            event.target.disabled = true;
            const output = document.getElementById('test-results');
            const results = [];
            let failures = 0;
            async function check(name, fn) {
                try { await fn(); results.push('通过 · ' + name); }
                catch (error) { failures += 1; results.push('失败 · ' + name + '：' + error.message); }
                output.textContent = results.join('\n');
            }
            await settle();

            await check('默认 PotPlayer 时显示网页按钮且不重复添加', async () => {
                assert(alternate()?.textContent === '在网页中播放', '按钮文本错误');
                assert(primary().nextElementSibling === alternate(), '按钮不在原按钮右侧');
                assert(document.querySelectorAll('#detail-controls [data-potplayer-choice]').length === 1, '重复按钮');
            });
            await check('网页选择仅放行原按钮一次，下次仍使用 PotPlayer', async () => {
                const webBefore = webCalls, nativeBefore = nativeCalls.length;
                alternate().click(); await settle();
                assert(webCalls === webBefore + 1 && nativeCalls.length === nativeBefore, '网页被重新拦截');
                assert(values.enabled === true, '默认值改变');
                primary().click(); await settle();
                assert(nativeCalls.length === nativeBefore + 1, '下次点击未使用 PotPlayer');
                assert(nativeCalls.at(-1).destination === 'default', '普通点击被当成手动选择');
                assert(nativeCalls.at(-1).items[0].itemId === 'ep4', 'EP4 条目错误');
            });
            await check('默认网页时可单次 PotPlayer，随后普通点击仍为网页', async () => {
                setDefaults({ enabled: false }); await settle();
                assert(alternate()?.textContent === '在PotPlayer中播放', '按钮未更新');
                const nativeBefore = nativeCalls.length, webBefore = webCalls;
                alternate().click(); await settle();
                assert(nativeCalls.length === nativeBefore + 1, '未发送 PotPlayer 请求');
                assert(nativeCalls.at(-1).destination === 'potplayer', '缺少单次覆盖');
                primary().click(); await settle();
                assert(webCalls === webBefore + 1 && values.enabled === false, '默认网页被改变');
            });
            await check('播放全部和随机播放保留原模式', async () => {
                for (const [selector, mode] of [['.itemsViewSettingsContainer .btnPlay', 'all'], ['.btnShuffle', 'random']]) {
                    document.querySelector(selector).nextElementSibling.click(); await settle();
                    assert(nativeCalls.at(-1).mode === mode, '错误播放模式 ' + mode);
                }
            });
            await check('改选网页后，迟到的媒体解析不会启动 PotPlayer', async () => {
                setDefaults({ enabled: true }); await settle();
                holdResponses = true;
                primary().click(); await settle();
                const pending = requests.at(-1), before = nativeCalls.length;
                alternate().click(); respond(pending); await settle();
                assert(nativeCalls.length === before, '旧解析结果仍触发播放');
                holdResponses = false;
            });
            await check('改选网页后，迟到的 Host 失败不会重复回退', async () => {
                holdNative = true;
                primary().click(); await settle();
                assert(typeof heldNativeCallback === 'function', '未建立测试请求');
                const before = webCalls;
                alternate().click();
                heldNativeCallback({ ok: false, error: '模拟失败' }); await settle();
                assert(webCalls === before + 1, '迟到失败重复点击网页');
                holdNative = false;
            });
            await check('详情页节点重建后保留一个按钮，使用新条目 ID', async () => {
                location.hash = '!/item?id=ep5&serverId=fixture';
                const replacement = primary().cloneNode(true);
                document.getElementById('detail-controls').replaceChildren(replacement);
                await settle();
                assert(document.querySelectorAll('#detail-controls [data-potplayer-choice]').length === 1, '重建后重复/缺失');
                primary().click(); await settle();
                assert(nativeCalls.at(-1).items[0].itemId === 'ep5', '仍在使用旧 EP4');
            });
            await check('原按钮隐藏或禁用时移除入口，恢复后重建', async () => {
                primary().hidden = true; await settle();
                assert(!alternate(), '隐藏按钮仍可点击');
                primary().hidden = false; primary().disabled = true; await settle();
                assert(!alternate(), '禁用按钮仍可点击');
                primary().disabled = false; await settle();
                assert(Boolean(alternate()), '未恢复按钮');
            });
            await check('移除允许站点后不再显示单次入口', async () => {
                setDefaults({ allowedOrigins: [] }); await settle();
                assert(document.querySelectorAll('[data-potplayer-choice]').length === 0, '未获准站点仍有入口');
                setDefaults({ allowedOrigins: [location.origin] }); await settle();
            });
            await check('窄容器自动换行，不横向溢出', async () => {
                const stage = document.getElementById('stage');
                stage.style.width = '320px'; await settle();
                assert(stage.scrollWidth <= stage.clientWidth + 1, '按钮溢出');
                stage.style.width = ''; await settle();
            });

            location.hash = '!/item?id=ep4&serverId=fixture';
            setDefaults({ enabled: true, allowedOrigins: [location.origin] });
            document.getElementById('default-player').value = 'potplayer';
            output.className = failures ? 'fail' : 'pass';
            output.textContent = results.join('\n') + '\n' + (results.length - failures) + '/' + results.length + ' 通过';
            event.target.disabled = false;
        });
    });
})();
