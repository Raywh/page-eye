<#
  start-env.ps1 —— 一键起「调试环境」
    1) 静态服务：python -m http.server 8000（你的博客）
    2) Chrome 调试端口：--remote-debugging-port=9222（给 MCP 用）

  用法：
    pwsh -ExecutionPolicy Bypass -File .\start-env.ps1
    pwsh -ExecutionPolicy Bypass -File .\start-env.ps1 -Lan          # 允许局域网访问（手机真机调）
    pwsh -ExecutionPolicy Bypass -File .\start-env.ps1 -BlogPort 8080 -CdpPort 9333
#>
param(
  [string]$SiteDir    = (Get-Location).Path,
  [int]   $BlogPort   = 8000,
  [int]   $CdpPort    = 9222,
  [string]$ProfileDir = "$env:TEMP\cdp-mcp-live",
  [switch]$Lan
)

$ErrorActionPreference = 'Stop'
$chrome = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
$logDir = Join-Path $env:TEMP 'cdp-debug-env'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-Port([int]$p) {
  try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', $p); return $true } catch { return $false }
}

# ---------------------------------------------------------------- 1) 静态服务
if (-not (Test-Path (Join-Path $SiteDir 'index.html'))) {
  throw "站点目录不对，找不到 index.html：$SiteDir"
}

if (Test-Port $BlogPort) {
  Write-Host "[=] 端口 $BlogPort 已在监听，跳过静态服务" -ForegroundColor DarkGray
} else {
  $bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
  $p = Start-Process python -PassThru -WindowStyle Hidden -WorkingDirectory $SiteDir `
        -ArgumentList @('-m', 'http.server', "$BlogPort", '--bind', $bind) `
        -RedirectStandardOutput (Join-Path $logDir 'blog.out.log') `
        -RedirectStandardError  (Join-Path $logDir 'blog.err.log')
  Start-Sleep -Milliseconds 900
  Write-Host "[+] 静态服务 PID $($p.Id)：$SiteDir  →  http://localhost:$BlogPort/  (bind $bind)" -ForegroundColor Green
}

# ---------------------------------------------------------------- 2) Chrome 调试端口
if (Test-Port $CdpPort) {
  Write-Host "[=] 端口 $CdpPort 已在监听，跳过 Chrome 启动" -ForegroundColor DarkGray
} else {
  if (-not (Test-Path $chrome)) { throw "找不到 Chrome：$chrome" }
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  $c = Start-Process $chrome -PassThru -ArgumentList @(
    "--remote-debugging-port=$CdpPort",
    "--user-data-dir=$ProfileDir",
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900',
    "http://localhost:$BlogPort/"
  )
  Start-Sleep -Seconds 3
  Write-Host "[+] Chrome PID $($c.Id)：调试端口 $CdpPort，配置目录 $ProfileDir" -ForegroundColor Green
}

# ---------------------------------------------------------------- 3) 自检
Write-Host ""
try {
  $v = (Invoke-WebRequest "http://127.0.0.1:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
  Write-Host "CDP   : $($v.Browser)" -ForegroundColor Cyan
  $pages = (Invoke-WebRequest "http://127.0.0.1:$CdpPort/json/list" -UseBasicParsing).Content | ConvertFrom-Json |
             Where-Object { $_.type -eq 'page' }
  Write-Host "标签  :" -ForegroundColor Cyan
  $pages | ForEach-Object { Write-Host "        - $($_.title)  |  $($_.url)" }
} catch { Write-Host "CDP   : 未就绪 — $($_.Exception.Message)" -ForegroundColor Red }

try {
  $r = Invoke-WebRequest "http://localhost:$BlogPort/" -UseBasicParsing -TimeoutSec 5
  Write-Host "站点  : HTTP $($r.StatusCode)，$($r.RawContentLength) bytes" -ForegroundColor Cyan
} catch { Write-Host "站点  : 未就绪 — $($_.Exception.Message)" -ForegroundColor Red }

Write-Host ""
Write-Host "MCP 侧只需连 http://127.0.0.1:$CdpPort 即可（.trae/mcp.json 里的 CDP_ENDPOINT）" -ForegroundColor Yellow
