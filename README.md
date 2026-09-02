# Emby/Jellyfin PotPlayer 播放桥

在 Emby 或 Jellyfin 网页中点击播放时，自动把视频或播放列表交给 Windows 本机 PotPlayer 播放。项目由 Chrome 扩展和一个本地 Native Host 组成，当前版本为 `v0.5.1`。

## 快速开始

### 直接下载 Release

从 [v0.5.1 Release](https://github.com/Moeary/Emby-Potplayer-Bridge/releases/tag/v0.5.1) 下载：

- `PotPlayerBridgeHost-0.5.1.exe`：本地播放桥程序。
- `EmbyPotPlayerBridge-0.5.1-extension.zip`：Chrome 扩展，解压后用于“加载已解压的扩展”。
- `config.toml`：配置模板。
- `SHA256SUMS.txt`：文件校验值。

### 从源码安装

需要 Windows、Chrome、PotPlayer 64 位版和 [pixi](https://pixi.sh/)。在仓库根目录执行：

```powershell
Copy-Item config.example.toml config.toml
```

编辑 `config.toml`，填写本机程序路径，例如：

```toml
[browser]
chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe"

[potplayer]
path = "D:/Programs/PotPlayer-Portable-2026/PotPlayerMini64.exe"
```

然后执行：

```powershell
pixi install
pixi run deploy
```

部署完成后，在 Chrome 地址栏打开 `chrome://extensions`：

1. 开启“开发者模式”。
2. 点击“加载已解压的扩展”。
3. 选择仓库里的 `dist/extension` 目录。

以后更新 Host 或扩展时再次运行 `pixi run deploy`，再在扩展页点击“重新加载”即可。部署只写当前用户的 Native Messaging 注册表项，不修改 Chrome 用户数据目录。

## 配置说明

根目录的 `config.toml` 只属于当前电脑，已被 Git 忽略，因此不会出现在 GitHub 的代码文件列表中。这是为了避免提交个人的 Chrome 和 PotPlayer 路径；仓库提供 `config.example.toml`，Release 中也提供空白 `config.toml` 模板。

如果不填写配置，部署脚本也会尝试使用 `CHROME_PATH`、`POTPLAYER_PATH` 和常见 Windows 安装路径。部署不会进行全盘扫描。

## 常见问题

- **找不到 PotPlayer**：确认配置指向 `PotPlayerMini64.exe`，并确保文件存在。
- **扩展没有拦截播放**：确认加载的是 `dist/extension`，重新加载扩展并刷新 Emby/Jellyfin 页面。
- **添加站点后无效**：在扩展提示出现时批准 Chrome 的站点权限，然后刷新页面。
- **播放列表过大**：扩展默认最多 1024 项，Native Host 硬上限为 4096 项。

## 项目目录

```text
src/
├─ chrome-extension/   Chrome MV3 扩展源码
├─ python-host/        Python Native Host 源码与测试
└─ README.md           技术实现、协议和开发说明
scripts/               构建、部署和清理脚本
config.example.toml    可提交的配置模板
pixi.toml              Pixi 环境与任务定义
```

协议、组件职责、扩展兼容约束和 GitHub Actions 说明见 [`src/README.md`](src/README.md)。
