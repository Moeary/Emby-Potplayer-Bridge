# Emby/Jellyfin PotPlayer 播放桥

这是一个运行在 Windows + Chrome 上的本地播放桥接工具（当前版本 `v0.5.0`）：在 Emby 或 Jellyfin 网页中点击“播放”“播放全部”或“随机播放”时，拦截网页播放器的启动流程，把当前视频或播放列表交给本机 PotPlayer 播放。

浏览器扩展的业务逻辑保持不变；本项目只将原来的 C#/.NET Native Host 替换为 Python 编写、由 PyInstaller 编译的独立 EXE，并将开发、构建、安装和部署统一到 pixi。

## 工作结构

```text
Chrome 页面
  ├─ extension/page-bridge.js     在页面主世界读取 Emby/Jellyfin API
  └─ extension/content-script.js  拦截播放按钮并发送消息
               │
               ▼
       extension/service-worker.js
               │ Chrome Native Messaging
               ▼
       PotPlayerBridgeHost.exe（Python compiled Native Host）
               │ 写入临时 M3U8、启动 PotPlayer
               ▼
       PotPlayerMini64.exe
```

Native Messaging Host 名称仍为 `com.codex.potplayer_bridge`，扩展 ID 仍为 `jfcncnejcohfbggolpklemgiaimadgmn`。通信不是 HTTP、WebSocket、URL Scheme 或 PowerShell，而是 Chrome Native Messaging 的 stdio 协议。

## 目录说明

```text
extension/
  manifest.json          Chrome MV3 扩展清单
  settings.js            默认值与配置归一化
  page-bridge.js         页面 API 与媒体地址解析
  content-script.js      播放按钮拦截、配置读取、消息转发
  service-worker.js      Native Messaging、动态网址权限和后台校验
  popup.html/js          工具栏设置弹框

native-host/
  main.py                Native Messaging 主循环
  native_messaging.py    4 字节小端长度 framing
  playlist.py            来源校验与临时 M3U8 生成
  potplayer.py           PotPlayer 查找与进程启动
  tests/                 Python 标准库自动化测试

scripts/
  build.py               编译 Host 并复制扩展
  deploy.py              安装 Host、manifest、注册表并打开扩展页面
  clean.py               清理生成物

pixi.toml                Python、PyInstaller 与任务定义
config.toml              本机 Chrome/PotPlayer 路径配置（不提交个人路径）
```

## 首次安装

准备：

- Windows。
- Chrome。
- PotPlayer 64 位版本，文件名为 `PotPlayerMini64.exe`。推荐便携版，或使用当前用户可写的安装目录。
- [pixi](https://pixi.sh/)。不再需要 .NET SDK、`dotnet`、MSBuild、虚拟环境或手动 `pip install`。

在仓库根目录执行：

```powershell
pixi install
pixi run deploy
```

`deploy` 会：

1. 编译 `dist/native-host/PotPlayerBridgeHost.exe`。
2. 将扩展复制到固定目录 `dist/extension`。
3. 查找 PotPlayer，并优先把 Host 与 Native Messaging manifest 放在 PotPlayer 目录。
4. 如果该目录不可写，则使用仓库内 `.deploy/native-host`，不要求管理员权限，并保存非敏感的播放器路径配置。
5. 写入当前用户 `HKCU` 注册表：

   `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.moeary.potplayer_bridge`

6. 验证 Host manifest 指向的 EXE、`allowed_origins` 和固定扩展 ID。
7. 自动打开 `chrome://extensions`。

第一次在 Chrome 中开启“开发者模式”，点击“加载已解压的扩展”，选择：

```text
<仓库>\dist\extension
```

之后每次只需运行 `pixi run deploy`，文件都会覆盖同一个目录；在 Chrome 扩展页点击一次“重新加载”即可。部署不会修改 Chrome 的 `User Data`、Preferences、Secure Preferences 或 Extensions 管理目录。

如果自动查找不到路径，编辑根目录的 `config.toml`：

```toml
[browser]
chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe"

[potplayer]
path = "D:/Apps/PotPlayer/PotPlayerMini64.exe"
```

也支持环境变量 `CHROME_PATH` 和 `POTPLAYER_PATH`。部署不会进行全盘扫描。

## pixi 任务

```powershell
pixi install                 # 创建/更新 pixi 环境
pixi run host                # 直接运行 Python Native Host
pixi run test                # 运行全部自动化测试
pixi run test-host           # 运行 Native Messaging 相关测试
pixi run build               # 编译 EXE 并生成 dist/extension
pixi run deploy              # 构建、安装、注册并打开 chrome://extensions
pixi run clean               # 删除 dist/ 和 .build/
```

直接运行 `pixi run host` 时 stdin/stdout 仍然是二进制 Native Messaging 协议，不适合手工输入；协议、Unicode、大消息、EOF、非法长度、播放列表边界和模拟进程启动均由 `pixi run test` 覆盖。

## GitHub Actions 发布

`.github/workflows/release.yml` 会在推送形如 `v0.5.0` 的标签时，在 Windows runner 上执行 `pixi install --locked`、测试和 `pixi run build`，然后发布 GitHub Release。Release 包含独立 Native Host、扩展 ZIP、空白 `config.toml` 模板和 SHA256 校验文件。

也可以在 GitHub Actions 页面手动运行该 workflow，并填写要发布的 `vMAJOR.MINOR.PATCH` 标签；workflow 会先验证标签版本与 `extension/manifest.json` 一致。GitHub runner 没有本机 PotPlayer，因此 Action 发布的是可部署构建包；本机安装仍使用 `pixi run deploy`。

## Native Messaging 协议与播放行为

每条消息使用：

```text
4-byte little-endian message length
+
UTF-8 JSON payload
```

扩展发送的请求 schema 保持原样：

```json
{
  "type": "play",
  "mode": "single",
  "items": [
    { "url": "https://…", "title": "…" }
  ],
  "allowedOrigins": ["https://emby.moear.de"]
}
```

Host 返回：

```json
{ "ok": true, "count": 1, "error": null }
```

失败时返回 `ok: false`、`count: 0` 和错误信息。stdout 只输出带 framing 的协议消息；错误日志写入：

```text
%TEMP%\PotPlayerPlaylists\native-host-error.txt
```

日志不会记录请求 payload，也会对认证参数进行脱敏。播放列表仍位于：

```text
%TEMP%\PotPlayerPlaylists\emby-jellyfin-*.m3u8
```

M3U8 使用 UTF-8 无 BOM、CRLF、`#EXTM3U` 和 `#EXTINF:-1,<标题>`，默认最多 1024 项，Host 硬上限为 4096 项。PotPlayer 启动参数保持为：

```text
PotPlayerMini64.exe /current <m3u8 路径>
```

默认优先使用 Host 所在目录的 `PotPlayerMini64.exe`；部署到独立目录时还会使用部署配置或常见 Windows 安装路径。不会使用 `potplayer://`、`potplayer-list://`、PowerShell 或浏览器直接启动播放器。

## 扩展设置

工具栏弹框可设置：

| 设置 | 默认值 | 允许范围 |
| --- | ---: | ---: |
| 使用 PotPlayer 外部播放 | 开启 | 开/关 |
| 播放列表上限 | 1024 | 1–4096 |
| 媒体源并发请求 | 6 | 1–12 |
| 解析超时 | 120 秒 | 15–300 秒 |
| 无媒体源项目 | 跳过 | 可停止整个列表 |
| 桥接失败 | 回退网页播放 | 可关闭回退 |

默认站点为：

- `https://emby.moear.de`
- `https://jellyfin.moear.de`

扩展清单中的稳定 `key`、扩展 ID、Native Host 名称和 `allowed_origins` 不应修改。添加站点时，Chrome 会请求相应的访问权限；批准后刷新网页标签页。

## 常见故障

- **部署找不到 Chrome**：在 `config.toml` 的 `[browser] chrome` 填写 `chrome.exe` 完整路径。
- **部署找不到 PotPlayer**：在 `config.toml` 的 `[potplayer] path` 填写 `PotPlayerMini64.exe` 完整路径，或设置 `POTPLAYER_PATH`。
- **点击后仍然网页播放**：确认扩展已从 `dist/extension` 加载并重新加载，且 Native Host 已执行 `pixi run deploy`。
- **添加站点后没有拦截**：批准 Chrome 权限请求，并刷新该站点标签页。
- **大目录失败**：确认弹框中的播放列表上限足够；超过 4096 项会被 Host 拒绝。

实际 PotPlayer 启动需要本机存在可执行文件；没有 GUI 或播放器的环境仍可通过 `pixi run test` 和 `pixi run build` 完成自动化验证。
