'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '../../src/chrome-extension/adapters/provider-core.js');

function loadCore() {
    const page = {
        location: {
            hostname: 'emby.moear.de',
            pathname: '/web/index.html',
            origin: 'https://emby.moear.de',
        },
    };
    const context = vm.createContext({ window: page, URL, console });
    vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context);
    return context.PotPlayerMediaAdapterCore;
}

test('普通卡片没有 DOM 条目 ID 时可按当前目录和名称反查', async () => {
    const core = loadCore();
    const calls = [];
    const api = {
        async getItems(userId, options) {
            calls.push({ userId, options });
            return {
                Items: [{
                    Id: 'ep4',
                    Name: '普通视频 EP4',
                    Type: 'Video',
                    Path: 'D:\\普通视频 EP4.mkv',
                }],
                TotalRecordCount: 1,
            };
        },
    };

    const item = await core.findItemByName(api, 'user-1', 'folder-1', '普通视频 EP4', 1024);

    assert.equal(item.Id, 'ep4');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userId, 'user-1');
    assert.equal(calls[0].options.ParentId, 'folder-1');
    assert.equal(calls[0].options.SearchTerm, '普通视频 EP4');
});
