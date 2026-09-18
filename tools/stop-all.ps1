<#
  停掉 start-all.ps1 拉起的全部服务。

  为什么优先按 PID 停：按端口停是"谁占着这个端口就杀谁"——
  万一 8765 上跑的是你自己的其他程序，按端口就是误伤。
  所以先读 logs\pids.json 里记下的 PID，端口只作为兜底。

  用法：
      .\tools\stop-all.ps1                 # 停全部
      .\tools\stop-all.ps1 -Only cosy      # 只停某一个（名字见 start-all 的输出）
      .\tools\stop-all.ps1 -KeepWeb        # 留着前端（改了后端想顺手刷新时方便）
#>
param(
  [string[]]$Only = @(),
  [switch]$KeepWeb
)

$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root "logs"
$pidFile = Join-Path $logs "pids.json"

<#
  允许 `-Only agent,web` 这种逗号写法 —— 理由同 start-all.ps1：
  经过 .cmd 包装转发时整个 "agent,web" 是一个字符串，不拆开就匹配不上，
  表现是「写了 -Only 却把全部停了」，而且不报错。
#>
$Only = @($Only) |
  ForEach-Object { $_ -split ',' } |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ }

function Stop-Port([int]$port, [string]$name) {
  $owners = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
  $hit = 0
  foreach ($processId in $owners) {
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "  按端口 $port 停掉 $($proc.ProcessName)（PID $processId）" -ForegroundColor DarkYellow
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
      $hit++
    }
  }
  if ($hit -eq 0) { Write-Host "  $name（端口 $port）本来就没在跑" -ForegroundColor DarkGray }
}

$targets = @{}
if (Test-Path $pidFile) {
  try {
    $saved = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $saved.PSObject.Properties) { $targets[$p.Name] = [int]$p.Value }
  } catch { Write-Host "pids.json 读不出来，改用端口兜底" -ForegroundColor DarkYellow }
}

# 端口兜底表：即使 pids.json 丢了也能停干净
$ports = @{ cosy = 8788; service = 8765; agent = 8766; web = 5176 }

Write-Host "`n=== 停止服务 ===" -ForegroundColor Cyan
foreach ($name in $ports.Keys) {
  if ($Only.Count -and ($Only -notcontains $name)) { continue }
  if ($KeepWeb -and $name -eq "web") { Write-Host "  保留前端（-KeepWeb）" -ForegroundColor DarkGray; continue }

  $stopped = $false
  if ($targets.ContainsKey($name)) {
    $proc = Get-Process -Id $targets[$name] -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $targets[$name] -Force -ErrorAction SilentlyContinue
      Write-Host "  停掉 $name（PID $($targets[$name])）" -ForegroundColor DarkYellow
      $stopped = $true
    }
  }
  if (-not $stopped) { Stop-Port $ports[$name] $name }
}

# 子进程：主服务的 uvicorn、vite 的 esbuild 之类会以子进程活着，端口停了它们也该走
foreach ($name in $targets.Keys) {
  $proc = Get-Process -Id $targets[$name] -ErrorAction SilentlyContinue
  if ($proc) { Stop-Process -Id $targets[$name] -Force -ErrorAction SilentlyContinue }
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "`n=== 复查端口 ===" -ForegroundColor Cyan
$busy = @()
foreach ($name in $ports.Keys) {
  $listen = Get-NetTCPConnection -LocalPort $ports[$name] -State Listen -ErrorAction SilentlyContinue
  if ($listen) { $busy += "$name($($ports[$name]))"; Write-Host "  $name 端口 $($ports[$name]) 还在监听 ❌" -ForegroundColor Red }
  else { Write-Host "  $name 端口 $($ports[$name]) 已释放 ✅" -ForegroundColor Green }
}
if ($busy.Count) { Write-Host "`n还有占用的：$($busy -join ', ')（可能是它们的子进程，稍等几秒或手动看 Get-Process）" -ForegroundColor Yellow }
Write-Host ""
