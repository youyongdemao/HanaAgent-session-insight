# scripts/sync-to-installed.ps1 — 把仓库内容同步到本机已安装的 App 目录
# 用法：powershell -File scripts/sync-to-installed.ps1 [-Target <dir>]
# 说明：
#   ui/ 下的静态资源改完，同步后刷新卡片即可生效；
#   index.js / lib/ 改完需要重新加载 App（扩展页「重新加载」），且子模块有时要重启宿主才彻底生效。

param(
  [string]$Target = 'D:\AI\Hanako\apps\session-insight-v2'
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $Target)) { throw "installed app dir not found: $Target" }

foreach ($item in @('index.js', 'manifest.json', 'package.json')) {
  Copy-Item -LiteralPath (Join-Path $src $item) -Destination $Target -Force
}
foreach ($dir in @('lib', 'ui', 'assets')) {
  Copy-Item -LiteralPath (Join-Path $src $dir) -Destination $Target -Recurse -Force
}

Write-Output "synced $src -> $Target"
