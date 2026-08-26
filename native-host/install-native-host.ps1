param(
    [Parameter(Mandatory = $true)]
    [string]$PotPlayerExe,
    [string]$ExtensionId = 'jfcncnejcohfbggolpklemgiaimadgmn'
)

$ErrorActionPreference = 'Stop'

$player = Get-Item -LiteralPath $PotPlayerExe
if ($player.PSIsContainer) {
    throw "PotPlayerExe 必须是 PotPlayerMini64.exe 文件路径。"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$projectPath = Join-Path $PSScriptRoot 'PotPlayerNativeHost.csproj'
$publishPath = Join-Path $repoRoot '.build\native-host'
$potPlayerDir = $player.Directory.FullName
$bridgePath = Join-Path $potPlayerDir 'PotPlayerBridgeHost.exe'
$manifestPath = Join-Path $potPlayerDir 'com.codex.potplayer_bridge.json'

New-Item -ItemType Directory -Force -Path $publishPath | Out-Null
$publishArgs = @(
    'publish', $projectPath,
    '-c', 'Release',
    '-r', 'win-x64',
    '--self-contained', 'true',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:EnableCompressionInSingleFile=true',
    '-o', $publishPath
)
& dotnet @publishArgs
if ($LASTEXITCODE -ne 0) {
    throw "Native Host 编译失败，退出码：$LASTEXITCODE"
}

Copy-Item -LiteralPath (Join-Path $publishPath 'PotPlayerBridgeHost.exe') -Destination $bridgePath -Force

$manifest = [ordered]@{
    name = 'com.codex.potplayer_bridge'
    description = 'Native Messaging bridge for Emby/Jellyfin PotPlayer playback'
    path = $bridgePath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$json = $manifest | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
[System.IO.File]::WriteAllText($manifestPath, $json, $utf8NoBom)

$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.codex.potplayer_bridge'
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifestPath

Write-Host "Native Host 已安装：$bridgePath"
Write-Host "清单已写入：$manifestPath"
Write-Host "Chrome Native Messaging 注册已完成（当前用户，无需管理员权限）。"
