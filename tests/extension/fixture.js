'use strict';

(() => {
    const PAGE_SOURCE = 'codex-emby-jellyfin-potplayer-page';
    const values = {
        enabled: true,
        defaultPlayer: 'potplayer',
        allowedOrigins: [location.origin],
        syncPlayback: false,
    };
    const changes = [];
    const requests = [];
    const nativeCalls = [];
    let webCalls = 0;
    let holdResponses = false;
    let holdNative = false;
    let heldNativeCallback = null;

    function showActivity() {
        const latest = nativeCalls.at(-1);
        document.getElementById('activity').textContent =
            '原始入口默认 ' + values.defaultPlayer + ' · 辅助入口左网页 / 右 PotPlayer' +
            ' · 网页播放 ' + webCalls + ' 次 · PotPlayer ' + nativeCalls.length + ' 次' +
            (latest ? '\n最近条目：' + latest.items[0].itemId : '');
    }

    // 只模拟扩展运行环境，不会写入真实 Chrome 扩展设置。
    window.chrome = {
        storage: {
            local: {
                get(_keys, callback) { queueMicrotask(() => callback({ ...values })); },
                set() { throw new Error('固定播放入口测试不得写入播放器状态'); },
            },
            onChanged: { addListener(fn) { changes.push(fn); } },
        },
        runtime: {
            onMessage: { addListener() {} },
            sendMessage(message, callback) {
                if (message.type === 'get-settings') {
                    queueMicrotask(() => callback({ ok: true, settings: { ...values } }));
                    return;
                }
                nativeCalls.push(message.payload);
                showActivity();
                if (holdNative) heldNativeCallback = callback;
                else queueMicrotask(() => callback({ ok: true }));
            },
        },
    };

    function setSettings(updates) {
        Object.assign(values, updates);
        changes.forEach((fn) => fn({}, 'local'));
        showActivity();
    }

    function setDefaultPlayer(value) {
        setSettings({ defaultPlayer: value, enabled: value === 'potplayer' });
        document.getElementById('default-player').value = value;
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
    const groupFor = (target) => target && target.nextElementSibling?.matches('[data-potplayer-choice-group]')
        ? target.nextElementSibling : null;
    const buttonFor = (target, destination) => groupFor(target)?.querySelector(
        `[data-potplayer-destination="${destination}"]`,
    );
    const assert = (condition, message) => { if (!condition) throw new Error(message); };

    window.addEventListener('DOMContentLoaded', () => {
        location.hash = '!/item?id=ep4&serverId=fixture';
        document.getElementById('default-player').addEventListener('change', (event) => {
            setDefaultPlayer(event.target.value);
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

            await check('详情页保留原始默认按钮，并在右侧生成两个辅助按钮', async () => {
                const original = primary();
                const group = groupFor(original);
                assert(group, '未生成按钮组');
                assert(group.querySelectorAll('[data-potplayer-choice]').length === 2, '按钮数量错误');
                assert(!original.hidden && original.getAttribute('aria-hidden') !== 'true', '原始按钮被隐藏');
                assert(!original.hasAttribute('data-potplayer-choice-original'), '原始按钮被标记为辅助按钮');
                assert(buttonFor(original, 'web').textContent === '在网页中播放', '左侧按钮文本错误');
                assert(buttonFor(original, 'potplayer').textContent === '在PotPlayer中播放', '右侧按钮文本错误');
                assert(original.nextElementSibling === group, '辅助按钮没有紧邻原始按钮');
            });
            await check('默认 PotPlayer 时原始播放按钮发送 EP4', async () => {
                setDefaultPlayer('potplayer'); await settle();
                const before = nativeCalls.length;
                primary().click(); await settle();
                const call = nativeCalls.at(-1);
                assert(nativeCalls.length === before + 1, '默认 PotPlayer 请求未发送');
                assert(call.destination === 'potplayer', '默认目标不是 PotPlayer');
                assert(call.items[0].itemId === 'ep4', '默认播放条目错误');
            });
            await check('默认网页时原始播放按钮放行网页播放器', async () => {
                setDefaultPlayer('web'); await settle();
                const webBefore = webCalls;
                const nativeBefore = nativeCalls.length;
                primary().click(); await settle();
                assert(webCalls === webBefore + 1, '默认网页播放器未调用');
                assert(nativeCalls.length === nativeBefore, '默认网页误触发 PotPlayer');
            });
            await check('两个辅助按钮始终按各自目标播放', async () => {
                const original = primary();
                setDefaultPlayer('web'); await settle();
                const webBefore = webCalls;
                const nativeBefore = nativeCalls.length;
                buttonFor(original, 'web').click(); await settle();
                assert(webCalls === webBefore + 1, '网页辅助按钮未调用网页播放器');
                assert(nativeCalls.length === nativeBefore, '网页辅助按钮触发了 PotPlayer');
                buttonFor(original, 'potplayer').click(); await settle();
                assert(nativeCalls.length === nativeBefore + 1, 'PotPlayer 辅助按钮未发送请求');
                assert(nativeCalls.at(-1).items[0].itemId === 'ep4', '辅助按钮条目错误');
            });
            await check('切换默认设置只影响原始按钮，不改变辅助按钮', async () => {
                const original = primary();
                const webBefore = webCalls;
                const nativeBefore = nativeCalls.length;
                setDefaultPlayer('potplayer'); await settle();
                original.click(); await settle();
                assert(nativeCalls.length === nativeBefore + 1, '切换后默认 PotPlayer 未生效');
                setDefaultPlayer('web'); await settle();
                original.click(); await settle();
                assert(webCalls === webBefore + 1, '切换后默认网页未生效');
                const before = nativeCalls.length;
                buttonFor(original, 'potplayer').click(); await settle();
                assert(nativeCalls.length === before + 1, '辅助 PotPlayer 按钮受默认设置影响');
            });
            await check('播放全部和随机播放也各自保留双按钮与模式', async () => {
                for (const [selector, mode] of [['.itemsViewSettingsContainer .btnPlay', 'all'], ['.btnShuffle', 'random']]) {
                    const original = document.querySelector(selector);
                    const group = groupFor(original);
                    assert(group && group.querySelectorAll('[data-potplayer-choice]').length === 2, '缺少模式按钮');
                    buttonFor(original, 'potplayer').click(); await settle();
                    assert(nativeCalls.at(-1).mode === mode, '错误播放模式 ' + mode);
                }
            });
            await check('改选网页后，迟到的媒体解析不会启动 PotPlayer', async () => {
                setDefaultPlayer('web'); await settle();
                holdResponses = true;
                buttonFor(primary(), 'potplayer').click(); await settle();
                const pending = requests.at(-1);
                assert(pending, '未建立媒体解析请求');
                const before = nativeCalls.length;
                buttonFor(primary(), 'web').click(); await settle();
                respond(pending); await settle();
                assert(nativeCalls.length === before, '旧解析结果仍触发播放');
                holdResponses = false;
            });
            await check('改选网页后，迟到的 Host 失败不会重复回退', async () => {
                holdNative = true;
                buttonFor(primary(), 'potplayer').click(); await settle();
                assert(typeof heldNativeCallback === 'function', '未建立测试请求');
                const before = webCalls;
                buttonFor(primary(), 'web').click(); await settle();
                heldNativeCallback({ ok: false, error: '模拟失败' }); await settle();
                assert(webCalls === before + 1, '迟到失败重复点击网页');
                holdNative = false;
                heldNativeCallback = null;
            });
            await check('详情页节点重建后使用新条目 ID', async () => {
                setDefaultPlayer('potplayer');
                location.hash = '!/item?id=ep5&serverId=fixture';
                const replacement = primary().cloneNode(true);
                replacement.hidden = false;
                replacement.removeAttribute('aria-hidden');
                replacement.removeAttribute('data-potplayer-choice-original');
                document.getElementById('detail-controls').replaceChildren(replacement);
                await settle();
                assert(!primary().hidden, '重建后的原始按钮被隐藏');
                assert(document.querySelectorAll('#detail-controls [data-potplayer-choice]').length === 2, '重建后按钮数量错误');
                buttonFor(primary(), 'potplayer').click(); await settle();
                assert(nativeCalls.at(-1).items[0].itemId === 'ep5', '仍在使用旧 EP4');
            });
            await check('原始控件禁用时移除辅助入口，恢复后重建', async () => {
                primary().disabled = true; await settle();
                assert(!groupFor(primary()), '禁用按钮仍有入口');
                primary().disabled = false; await settle();
                assert(groupFor(primary())?.querySelectorAll('[data-potplayer-choice]').length === 2, '未恢复双按钮');
            });
            await check('移除允许站点后不再显示入口', async () => {
                setSettings({ allowedOrigins: [] }); await settle();
                assert(document.querySelectorAll('[data-potplayer-choice]').length === 0, '未获准站点仍有入口');
                setSettings({ allowedOrigins: [location.origin] }); await settle();
            });
            await check('窄容器不产生横向溢出', async () => {
                const stage = document.getElementById('stage');
                stage.style.width = '320px'; await settle();
                assert(stage.scrollWidth <= stage.clientWidth + 1, '按钮溢出');
                stage.style.width = ''; await settle();
            });

            location.hash = '!/item?id=ep4&serverId=fixture';
            setDefaultPlayer('potplayer');
            setSettings({ allowedOrigins: [location.origin] });
            output.className = failures ? 'fail' : 'pass';
            output.textContent = results.join('\n') + '\n' + (results.length - failures) + '/' + results.length + ' 通过';
            event.target.disabled = false;
        });
    });
})();
