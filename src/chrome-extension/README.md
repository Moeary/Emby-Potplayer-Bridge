# Chrome 扩展源码

这是 Emby/Jellyfin PotPlayer 播放桥的 Chrome MV3 扩展源码。项目概览、安装步骤和用户配置说明请参阅仓库根目录的 README.md；源码结构和 Native Host 技术说明请参阅 src/README.md。

## 目录

- adapters/provider-core.js：共用媒体 API、Series/Season → Episode 解析、播放列表和 URL 生成。
- adapters/emby.js：Emby 服务识别与 /emby/videos 流地址适配。
- adapters/jellyfin.js：Jellyfin 服务识别与 /Videos 流地址适配。
- page-bridge.js：在页面主世界调用 Emby/Jellyfin 已有的 API。
- content-script.js：捕获固定双按钮，分别转发网页播放或 Native Host。
- playback-choice.js / playback-choice.css：生成网页/PotPlayer 连体入口，监听 SPA 页面与站点设置变化。
- service-worker.js：Native Messaging 和动态站点脚本注册。

可用 `node --test tests/extension/*.test.cjs` 运行后台回归测试；浏览器交互回归页位于仓库根目录 `tests/extension/fixture.html`（经本地 HTTP 服务打开）。

开发调试时打开 chrome://extensions → 开启开发者模式 → “加载已解压的扩展” → 选择本目录。
