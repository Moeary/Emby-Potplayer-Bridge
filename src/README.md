# 源码与技术说明

这里放项目源码。面向普通用户的安装和使用说明在仓库根目录的 [README.md](../README.md)。

## 目录结构

```text
src/
├─ chrome-extension/       Chrome MV3 扩展源码
│  ├─ manifest.json         固定扩展 key、权限和入口
│  ├─ settings.js           默认设置与配置归一化
│  ├─ page-bridge.js        页面主世界 API 与媒体地址解析
│  ├─ content-script.js     播放按钮拦截、配置读取和消息转发
│  ├─ service-worker.js     Native Messaging、动态权限和后台校验
│  └─ popup.html/js         工具栏设置界面
└─ python-host/             Python Chrome Native Messaging Host
   ├─ main.py               Native Messaging 主循环和请求处理
   ├─ native_messaging.py   4 字节小端长度 framing
   ├─ playlist.py           来源校验和临时 M3U8 生成
   ├─ potplayer.py          PotPlayer 查找和进程启动
   └─ tests/                标准库 unittest 测试
```

构建与部署脚本在根目录 `scripts/`，本地路径配置使用根目录的 `config.toml`。可从 `config.example.toml` 复制模板；真实的 `config.toml` 被 `.gitignore` 忽略，不应提交个人路径。

## 运行链路

```text
Emby/Jellyfin 页面
  └─ src/chrome-extension/page-bridge.js
     └─ src/chrome-extension/content-script.js
        └─ src/chrome-extension/service-worker.js
           └─ Chrome Native Messaging
              └─ PotPlayerBridgeHost.exe
                 ├─ 写入 %TEMP%/PotPlayerPlaylists/*.m3u8
                 └─ PotPlayerMini64.exe /current <playlist>
```

扩展的业务逻辑、稳定 `key`、扩展 ID `jfcncnejcohfbggolpklemgiaimadgmn` 和 Native Host 名称 `com.codex.potplayer_bridge` 必须保持兼容。Native Host 不使用 HTTP、WebSocket、URL Scheme 或 PowerShell 启动播放器。

## Native Messaging 协议

每条消息使用 4 字节 little-endian 有符号长度，后跟 UTF-8 JSON。请求保持原扩展协议：

```json
{
  "type": "play",
  "mode": "single",
  "items": [{"url": "https://…", "title": "…"}],
  "allowedOrigins": ["https://emby.moear.de"]
}
```

成功响应为：

```json
{"ok": true, "count": 1, "error": null}
```

Host 只向 stdout 输出带 framing 的协议响应；诊断写入 `%TEMP%/PotPlayerPlaylists/native-host-error.txt`，请求内容不会写入日志，认证参数会脱敏。

播放列表使用 UTF-8 无 BOM、CRLF、`#EXTM3U` 和 `#EXTINF:-1,<标题>`，默认最多 1024 项，Host 硬上限为 4096 项。

## 本地开发命令

```powershell
pixi install
pixi run test       # 全部测试
pixi run test-host  # Native Host 测试
pixi run build      # PyInstaller EXE + dist/extension
pixi run deploy     # 安装 Host、注册 HKCU manifest 并打开扩展页
pixi run clean
```

`pixi run deploy` 会从 `src/chrome-extension/` 复制扩展，从 `src/python-host/main.py` 构建 Host，并把 Native Messaging manifest 注册到当前用户：

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.codex.potplayer_bridge
```

GitHub Actions 位于 `.github/workflows/release.yml`，会校验 `src/chrome-extension/manifest.json` 版本，运行测试、构建 Windows EXE，并发布扩展压缩包和 `config.toml` 空模板。Action runner 不执行本机 PotPlayer 部署。
