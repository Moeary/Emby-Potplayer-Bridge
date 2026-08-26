# Emby/Jellyfin PotPlayer 播放桥

这是一个运行在 Windows + Chrome 上的本地播放桥接工具：在 Emby 或 Jellyfin 网页中点击“播放”“播放全部”或“随机播放”时，拦截网页播放器的启动流程，把当前视频或播放列表交给本机 PotPlayer 播放。

## 它解决什么问题

- 支持单个视频、当前目录播放全部、当前目录随机播放。
- 通过 M3U8 播放列表把多个远程媒体地址交给 PotPlayer。
- 不依赖 `potplayer://` 或 `potplayer-list://` URL，因此不会受到嵌套 URL 编码和地址长度的影响。
- 不依赖 PowerShell 执行播放；Chrome 通过 Native Messaging 直接启动本地桥接程序。
- 默认支持 1024 个播放项目，硬安全上限为 4096 个。

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
       native-host/PotPlayerBridgeHost.exe
               │ 写入临时 M3U8、启动 PotPlayer
               ▼
       PotPlayerMini64.exe
```

`extension/settings.js` 是各层共享的配置定义。工具栏弹框由 `extension/popup.html` 和 `extension/popup.js` 提供。

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
  Program.cs                     Native Messaging 宿主源码
  PotPlayerNativeHost.csproj     .NET 9 项目文件
  install-native-host.ps1        编译、部署和注册脚本
```

## 首次安装

### 1. 准备环境

- Windows。
- Chrome。
- PotPlayer 64 位版本。推荐使用便携版，并保留 `PotPlayerMini64.exe`。
- .NET 9 SDK，用于编译 Native Host。

### 2. 安装 Native Host

在仓库根目录打开 PowerShell，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\install-native-host.ps1 `
  -PotPlayerExe 'D:\Apps\PotPlayer\PotPlayerMini64.exe'
```

脚本会：

1. 编译自包含的 `PotPlayerBridgeHost.exe`。
2. 将它复制到 `PotPlayerMini64.exe` 同目录。
3. 在同目录生成 `com.codex.potplayer_bridge.json`。
4. 写入当前用户的 Chrome Native Messaging 注册表，不需要管理员权限。

Native Host 默认按自身目录寻找 `PotPlayerMini64.exe`，所以换设备时只需重新执行脚本。若 PotPlayer 文件名或位置特殊，也可以设置环境变量 `POTPLAYER_PATH` 指向实际的 exe。

### 3. 加载 Chrome 扩展

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展”，选择本仓库的 `extension` 目录。
4. 扩展 ID 应为：

   `jfcncnejcohfbggolpklemgiaimadgmn`

5. 刷新 Emby/Jellyfin 页面。

旧版油猴脚本若仍安装，建议停用，避免它再次调用旧的协议处理器。

## 使用与设置

点击 Chrome 工具栏中的扩展图标打开设置弹框。当前默认值为：

| 设置 | 默认值 | 允许范围 |
| --- | ---: | ---: |
| 使用 PotPlayer 外部播放 | 开启 | 开/关 |
| 播放列表上限 | 1024 | 1–4096 |
| 媒体源并发请求 | 6 | 1–12 |
| 解析超时 | 120 秒 | 15–300 秒 |
| 无媒体源项目 | 跳过 | 可停止整个列表 |
| 桥接失败 | 回退网页播放 | 可关闭回退 |

默认允许的站点：

- `https://emby.moear.de`
- `https://jellyfin.moear.de`

添加其他站点时填写网址并保存。Chrome 会请求该站点的访问权限；批准后刷新该站点标签页。填写带路径的完整网址也可以，程序会按 `协议 + 域名 + 端口` 的来源处理。

关闭“使用 PotPlayer 外部播放”后会立即恢复网页播放，不需要额外点击保存。

## 从 Git 继续开发

仓库中不提交 `bin/`、`obj/`、自包含 exe 和临时播放列表。另一台设备上先安装 .NET 9 SDK，再执行上面的安装脚本即可重新生成 Native Host。Chrome 扩展是解压加载的，修改 `extension` 中的文件后在 `chrome://extensions` 点击“重新加载”，再刷新目标网页。

运行过程中生成的临时播放列表位于 Windows `%TEMP%\PotPlayerPlaylists\`；Native Host 错误记录也在该目录的 `native-host-error.txt` 中，不会把媒体令牌写入日志。

## 常见故障

- **点击后仍然网页播放**：检查扩展是否已重新加载、工具栏弹框是否开启 PotPlayer、Native Host 是否已执行安装脚本。
- **添加站点后没有拦截**：确认 Chrome 权限请求已批准，并刷新该站点标签页。
- **PotPlayer 找不到**：确认 `PotPlayerBridgeHost.exe` 与 `PotPlayerMini64.exe` 在同一目录，或设置 `POTPLAYER_PATH`。
- **大目录失败**：先把播放列表上限调到大于目录项目数；若媒体源请求较慢，适当提高解析超时并调整并发数进行尝试。
