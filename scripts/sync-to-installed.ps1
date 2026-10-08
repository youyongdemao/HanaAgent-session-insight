# scripts/sync-to-installed.ps1 — 把仓库内容同步到本机已安装的 App 目录
# 用法：powershell -File scripts/sync-to-installed.ps1 [-Target <dir>]
# 说明：
#   ui/ 下的静态资源改完，同步后刷新卡片即可生效；
#   index.js / lib/ 改完需要重新加载 App（扩展页「重新加载」），且子模块有时要重启宿主才彻底生效。

param(
  [string]$Target = 'D:\AI\Hanako\apps\session-insight'
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

# 静态资源按 URL 被宿主缓存：每次同步给 HTML 里的资源 URL 换一个版本串，
# 免得上线了页面还吃旧文件（资源 URL 不变，浏览器就一直命中缓存，重启也一样）。
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$htmlEnc = New-Object System.Text.UTF8Encoding($false)
foreach ($html in @('ui\widget.html', 'ui\panel.html')) {
  $htmlPath = Join-Path $Target $html
  if (-not (Test-Path -LiteralPath $htmlPath)) { continue }
  $txt = [System.IO.File]::ReadAllText($htmlPath, $htmlEnc)
  $txt = [regex]::Replace($txt, '(\./assets/[^"?]+\.(?:css|js))\?v=[^"]*', ('$1?v=' + $stamp))
  [System.IO.File]::WriteAllText($htmlPath, $txt, $htmlEnc)
}
Write-Output "assets   : ?v=$stamp"

# 死规则体检：新规则压住旧规则时，旧的那条必须删掉（纪律见 CSS-MAINTENANCE.md）。
# 只警告不阻断，免得同步被卡住。
try {
  $audit = (& node (Join-Path $PSScriptRoot 'css-dead-rules.cjs') 2>&1) -join "`n"
  if ($audit -match '整条被覆盖的规则\s+(\d+)\s+条') {
    $n = [int]$Matches[1]
    if ($n -gt 0) {
      Write-Warning "CSS 里有 $n 条规则被后续规则完全覆盖，按纪律应删掉旧的那条：node scripts/css-prune.cjs"
    } else {
      Write-Output 'CSS 体检：没有被完全覆盖的规则'
    }
  }
} catch {
  Write-Warning "CSS 体检没跑成：$_"
}
