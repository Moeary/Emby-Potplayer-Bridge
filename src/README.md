# 源码与技术说明

这里放项目源码。面向普通用户的安装和使用说明在仓库根目录的 [README.md](../README.md)。

## 目录结构

```text
src/
├─ chrome-extension/       Chrome MV3 扩展源码
│  ├─ manifest.json         固定扩展 key、权限和入口
│  ├─ adapters/             播放服务适配层
│  │  ├─ provider-core.js   Emby/Jellyfin 共用 API、剧集解析和地址生成
│  │  ├─ emby.js             Emby 端点与服务识别
│  │  └─ jellyfin.js         Jellyfin 端点与服务识别
│  ├─ settings.js           默认设置与配置归一化
│  ├─ page-bridge.js        页面主世界 API 与媒体请求协调
│  ├─ content-script.js     播放按钮拦截、配置读取和消息转发
│  ├─ playback-choice.js/css 默认入口旁的辅助双按钮和动态页面维护
│  ├─ service-worker.js     Native Messaging、动态权限和后台校验
│  └─ popup.html/js         工具栏设置界面
└─ python-host/             Python Chrome Native Messaging Host
   ├─ main.py               Native Messaging 主循环和请求处理
   ├─ native_messaging.py   4 字节小端长度 framing
   ├─ playlist.py           来源校验和临时 M3U8 生成
   ├─ potplayer.py          PotPlayer 查找和进程启动
   └─ tests/                标准库 unittest 测试
```

构建与部署脚本在根目录 scripts/，本地路径配置使用根目录的 config.toml。可从 config.example.toml 复制模板；真实的 config.toml 被 .gitignore 忽略，不应提交个人路径。

## 运行链路

```text
Emby/Jellyfin 页面
  ├─ page-bridge.js
  │  └─ adapters/provider-core.js
  │     ├─ adapters/emby.js
  │     └─ adapters/jellyfin.js
  └─ content-script.js
     └─ service-worker.js
        └─ Chrome Native Messaging
           └─ PotPlayerBridgeHost.exe
              ├─ 写入 %TEMP%/PotPlayerPlaylists/*.m3u8
              └─ PotPlayerMini64.exe /current <playlist> [/seek=hh:mm:ss.ms]
                 └─ WM_USER 0x5004/0x5002 查询位置与时长
```

content-script.js 只负责识别用户的播放动作和阻止网页默认行为；page-bridge.js 负责调用页面已有的 API。播放服务的差异集中在 adapters/：共享核心处理剧集、播放列表、令牌和排序，Emby/Jellyfin 适配器分别提供服务识别与流地址前缀。

详情页和列表播放控件会保留原始播放按钮，并在右侧显示固定的连体双按钮：原始按钮遵循 `defaultPlayer`（兼容旧版 `enabled`）决定默认走网页或 PotPlayer；辅助组左侧 `在网页中播放` 仅本次放行原始站点控件，右侧 `在PotPlayer中播放` 仅本次进入解析和 Native Messaging，辅助按钮不会修改默认设置。后台仍验证发送页面的来源是否获准；新的播放请求或页面跳转会取消尚未完成的旧解析请求。

系列详情页点击“播放”时，解析顺序为：

1. 优先读取 NextUp 返回的下一集。
2. NextUp 为空或不可用时，按季号、集号读取该系列的第一集及后续集。
3. 逐集获取媒体源，跳过没有可用源的项目，直到生成可交给 PotPlayer 的地址。

因此 #!/item?id=... 指向 Series 或 Season 时，不会再把容器本身当作视频请求，也不会因没有 MediaSources 而直接回退到网页播放。

扩展的业务逻辑、稳定 key、扩展 ID jfcncnejcohfbggolpklemgiaimadgmn 和 Native Host 名称 com.codex.potplayer_bridge 必须保持兼容。Native Host 不使用 HTTP、WebSocket、URL Scheme 或 PowerShell 启动播放器。

## Native Messaging 协议

每条消息使用 4 字节 little-endian 有符号长度，后跟 UTF-8 JSON。请求保持原扩展协议：

```json
{
  "type": "play",
  "mode": "single",
  "requestId": "页面请求 ID",
  "sessionId": "PotPlayer 监控会话 ID",
  "syncPlayback": true,
  "items": [{
    "url": "https://…",
    "title": "…",
    "itemId": "媒体 ID",
    "mediaSourceId": "媒体源 ID",
    "startPositionTicks": 0,
    "runtimeTicks": 0
  }],
  "allowedOrigins": ["https://emby.moear.de"]
}
```

成功响应为：

```json
{"ok": true, "count": 1, "error": null, "sessionId": "PotPlayer 监控会话 ID"}
```

Host 首先输出带 framing 的成功响应，随后在保持 Native Messaging 连接期间输出 playback-progress 与 playback-stopped 事件；诊断写入 %TEMP%/PotPlayerPlaylists/native-host-error.txt，请求内容不会写入日志，认证参数会脱敏。网页端用当前 Emby/Jellyfin 登录会话回报 /Sessions/Playing、/Progress、/Stopped，不需要额外 API key。

播放列表使用 UTF-8 无 BOM、CRLF、#EXTM3U 和 #EXTINF:-1,<标题>，默认最多 1024 项，Host 硬上限为 4096 项。首项的 startPositionTicks 转换为 PotPlayer /seek；后续项目在流地址中携带 StartTimeTicks。

## 本地开发命令

```powershell
pixi install
pixi run test       # 全部测试
pixi run test-host  # Native Host 测试
pixi run build      # PyInstaller EXE + dist/extension
pixi run deploy     # 安装 Host、注册 HKCU manifest 并打开扩展页
pixi run clean
```

pixi run deploy 会从 src/chrome-extension/ 复制扩展，从 src/python-host/main.py 构建 Host，并把 Native Messaging manifest 注册到当前用户：

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.codex.potplayer_bridge
```

GitHub Actions 位于 .github/workflows/release.yml，会校验 src/chrome-extension/manifest.json 版本，运行测试、构建 Windows EXE，并发布扩展压缩包和 config.toml 空模板。Action runner 不执行本机 PotPlayer 部署。



## 字幕与播放进度

扩展只负责解析媒体地址和把播放交给 PotPlayer，字幕字体由 PotPlayer 自身渲染，当前桥接协议没有安全稳定的字体命令行参数。建议在 PotPlayer 中打开“字幕样式/字体”，选择 Microsoft YaHei、思源黑体或 Noto Sans CJK SC 等中文字体；若 ASS/SSA 文件强制写入字体样式，关闭“使用字幕中定义的样式”或启用“仅覆盖字体”。若出现方框，先安装对应中文字体；若字幕完全不显示，则应另行检查字幕轨道选择。

扩展设置新增“按 Emby/Jellyfin 记录从上次位置播放”和“将 PotPlayer 播放进度同步回服务器”。默认开启，关闭同步后不再建立回报会话；关闭断点恢复后仍可同步 PotPlayer 当前播放位置。Native Host 不接触令牌，网页端通过当前页面 API 或同源兼容请求完成回报。
