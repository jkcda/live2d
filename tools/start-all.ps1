<#
  一键拉起她需要的全部服务。

  为什么需要它：这条链路现在是四个进程（模型 / 主服务 / agent / 前端），
  各自有自己的环境、端口和环境变量。手敲四遍的结果就是"漏一个"，
  而漏掉的表现还各不相同 —— 漏模型服务是"没声音"、漏 agent 是"她变笨了"、
  漏前端是"啥也没有"。所以做成一条命令 + 启动完**自动探活并打印结果**。

  用法：
      .\tools\start-all.ps1                 # 全部拉起（已起的会自动跳过）
      .\tools\start-all.ps1 -Electron       # 前端用 Electron 窗口（桌宠形态）而不是 dev server
      .\tools\start-all.ps1 -Skip agent     # 只起前三个
      .\tools\start-all.ps1 -CosyPort 8790  # 改端口

  停止：.\tools\stop-all.ps1
  日志：logs\<名字>.log（这脚本把输出都重定向到那儿，控制台只留结论）
#>
param(
  [string[]]$Skip = @(),
  [switch]$Electron,
  [int]$CosyPort = 8788,
  [int]$ServicePort = 8765,
  [int]$AgentPort = 8766,
  [int]$WebPort = 5176
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$pidFile = Join-Path $logs "pids.json"

<#
  ★ 清掉大小写重复的代理变量 —— 不清的话下面四个 Start-Process 全部失败。

  Windows 的环境变量块里可以同时存在 http_proxy 和 HTTP_PROXY，
  而 .NET 的 ProcessStartInfo.EnvironmentVariables 是个**大小写不敏感**的字典，
  Start-Process 往里塞的时候就撞键：

      Start-Process : 已添加项。字典中的关键字:"http_proxy"所添加的关键字:"HTTP_PROXY"

  报错信息里完全看不出跟代理有关，表现是"四个服务一个都没起来"。

  而同时设两种写法是**很常见**的：Python 的 requests 读小写、很多 CLI 读大写，
  不少安装脚本/容器/代理软件就两套都写。撞上了极难排查。

  这里只保留大写那套（更通行的约定），小写清掉。
  注意 PowerShell 的 Env: 提供程序本身就是大小写不敏感的，
  所以删一个就够，不用删两遍。
#>
foreach ($name in 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy') {
  if (Test-Path "Env:$name") {
    Remove-Item -Path "Env:$name" -Force -ErrorAction SilentlyContinue
  }
}

function Test-Port([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Http([string]$url, [int]$seconds = 40) {
  # 探活：不是"进程起来了"就算成功 —— 模型加载要十几秒，那期间端口是通的但接口还没好
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod $url -TimeoutSec 3
      return $r
    } catch { Start-Sleep -Milliseconds 800 }
  }
  return $null
}

$pids = @{}
$rows = @()

function Start-Svc {
  param(
    [string]$Name,
    [int]$Port,
    [string]$File,
    # ★ 参数名不能叫 $Args —— 那是 PowerShell 的自动变量（未绑定参数的数组）。
    #   叫这个名字的话，函数里拿到的是那个空数组，Start-Process 会报
    #   "ArgumentList 为空"（第一版就是这么挂的，四个服务一个都没起来）。
    [string[]]$ArgList,
    [string]$WorkDir,
    [hashtable]$Env
  )

  if ($Skip -contains $Name) { $script:rows += [pscustomobject]@{ 服务=$Name; 端口=$Port; 结果="跳过"; 说明="" }; return }
  if (Test-Port $Port) { $script:rows += [pscustomobject]@{ 服务=$Name; 端口=$Port; 结果="已在跑"; 说明="跳过启动" }; return }
  if (-not (Test-Path $File)) { $script:rows += [pscustomobject]@{ 服务=$Name; 端口=$Port; 结果="失败"; 说明="找不到 $File" }; return }

  # 环境变量：PS 5.1 的 Start-Process 没有 -Environment，靠"设好再启动"让子进程继承
  if ($Env) { foreach ($k in $Env.Keys) { Set-Item -Path "Env:$k" -Value $Env[$k] } }

  $log = Join-Path $logs "$Name.log"
  $errLog = Join-Path $logs "$Name.err.log"
  $proc = Start-Process -FilePath $File -ArgumentList $ArgList -WorkingDirectory $WorkDir `
    -RedirectStandardOutput $log -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
  $script:pids[$Name] = $proc.Id
  $script:rows += [pscustomobject]@{ 服务=$Name; 端口=$Port; 结果="已启动"; 说明="PID $($proc.Id)" }
}

Write-Host "`n=== 拉起服务（日志在 logs\）===" -ForegroundColor Cyan

# ① CosyVoice 模型服务：她自己的音色（GPU，加载 10~15 秒）
$cosyRoot = if ($env:NEXUS_COSY_ROOT) { $env:NEXUS_COSY_ROOT } else { "D:\cosyvoice" }
Start-Svc -Name "cosy" -Port $CosyPort -WorkDir $root `
  -File (Join-Path $cosyRoot ".venv\Scripts\python.exe") `
  -ArgList @((Join-Path $root "python\cosyvoice_server.py"), "--port", "$CosyPort") `
  -Env @{ NEXUS_COSY_PORT = "$CosyPort"; PYTHONIOENCODING = "utf-8"; NEXUS_VOICES_DIR = (Join-Path $root "python\voices") }

# ② 主推理服务：TTS 转发 + VAD/ASR（应用连的就是它）
$asrEngine = if ($env:NEXUS_ASR_ENGINE) { $env:NEXUS_ASR_ENGINE } else { "sensevoice" }
# ★ 必须找 pnpm.cmd，不能要 pnpm.ps1：
#   Windows 上 pnpm 是 .ps1/.cmd 的封装，而 Start-Process 执行不了 .ps1
#   （要 powershell.exe -File 才行）—— 第一版就是这儿把 agent 和前端漏掉的。
$pnpmPath = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpmPath) {
  $shim = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
  if ($shim) {
    $candidate = Join-Path (Split-Path $shim) "pnpm.cmd"
    if (Test-Path $candidate) { $pnpmPath = $candidate }
  }
}
if (-not $pnpmPath) { Write-Host "⚠ 找不到 pnpm.cmd —— agent 和前端这两项会跳过" -ForegroundColor Yellow }
Start-Svc -Name "service" -Port $ServicePort -WorkDir (Join-Path $root "python") `
  -File (Join-Path $root "python\.venv\Scripts\python.exe") -ArgList @("-m", "service.main") `
  -Env @{
    NEXUS_PORT          = "$ServicePort"
    NEXUS_TTS_ENGINE    = "cosyvoice"
    NEXUS_COSYVOICE_URL = "http://127.0.0.1:$CosyPort"
    NEXUS_ASR_ENGINE    = $asrEngine
    NEXUS_VAD_ENGINE    = "energy"
    PYTHONIOENCODING    = "utf-8"
  }

# ③ agent 服务：工具 / MCP / 记忆
Start-Svc -Name "agent" -Port $AgentPort -WorkDir (Join-Path $root "agent") `
  -File $pnpmPath -ArgList @("start") `
  -Env @{ AGENT_PORT = "$AgentPort" }

# ④ 前端：dev server（浏览器看）或 Electron（桌宠窗口）
if ($Electron) {
  if ($pnpmPath -and -not (Test-Port $WebPort)) {
    $proc = Start-Process -FilePath $pnpmPath -ArgumentList @("dev") -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $pids["electron"] = $proc.Id
    $rows += [pscustomobject]@{ 服务="Electron 窗口"; 端口="—"; 结果="已启动"; 说明="她会出现，可能需要几秒" }
  } else {
    $rows += [pscustomobject]@{ 服务="Electron 窗口"; 端口="—"; 结果="跳过"; 说明="dev server 已在跑，或 pnpm 不在 PATH" }
  }
} else {
  Start-Svc -Name "web" -Port $WebPort -WorkDir $root -File $pnpmPath -ArgList @("dev:web")
}

# 记录 PID：stop-all 优先按它精确停（按端口停容易误伤别的程序）
$pids | ConvertTo-Json -Depth 3 | Set-Content $pidFile -Encoding UTF8

Write-Host "`n=== 探活（模型加载要十几秒，最多等 60 秒）===" -ForegroundColor Cyan
$cosy = Wait-Http "http://127.0.0.1:$CosyPort/health" 60
$svc = Wait-Http "http://127.0.0.1:$ServicePort/health" 30
$agt = Wait-Http "http://127.0.0.1:$AgentPort/health" 30

$report = @()
$report += [pscustomobject]@{
  键 = "cosy"; 服务 = "CosyVoice 模型"
  端口 = $CosyPort
  状态 = if ($cosy -and $cosy.model_ready) { "就绪" } elseif ($cosy) { "加载中" } else { "没响应" }
  说明 = if ($cosy) { "$($cosy.device)｜音色 $($cosy.voices -join ',')" } else { "看 logs\cosy.err.log" }
}
$report += [pscustomobject]@{
  键 = "service"; 服务 = "主推理服务"
  端口 = $ServicePort
  状态 = if ($svc -and $svc.engine_ready) { "就绪" } else { "没响应" }
  说明 = if ($svc) { "引擎 $($svc.engine)｜ASR $($svc.asr.name)" } else { "看 logs\service.err.log" }
}
$report += [pscustomobject]@{
  键 = "agent"; 服务 = "agent（工具/MCP/记忆）"
  端口 = $AgentPort
  状态 = if ($agt -and $agt.ok) { "就绪" } else { "没响应" }
  说明 = if ($agt) { "MCP $($agt.mcp.state)（工具 $($agt.mcp.toolCount)）｜记忆 $($agt.memoryFiles) 条" } else { "看 logs\agent.err.log" }
}
$report += [pscustomobject]@{
  键 = "web"; 服务 = "前端"
  端口 = $WebPort
  状态 = if (Test-Port $WebPort) { "在跑" } else { "没起来" }
  # ★ 实测：这台机器的 vite 只绑 IPv6，用 127.0.0.1 会连接被拒
  说明 = if (Test-Port $WebPort) { "http://localhost:$WebPort/ （注意别用 127.0.0.1）" } else { "看 logs\web.err.log" }
}

Write-Host ""
$rows | Format-Table -AutoSize
Write-Host ""
$report | Format-Table -AutoSize

$bad = @($report | Where-Object { $_.状态 -eq "没响应" -or $_.状态 -eq "没起来" })
if ($bad.Count) {
  Write-Host "有 $($bad.Count) 项没起来 —— 日志在 $logs" -ForegroundColor Yellow
  # 日志文件名用的是内部名（cosy/service/agent/web），不是上面那列中文显示名
  foreach ($b in $bad) { Write-Host "  · $($b.服务)：$(Join-Path $logs "$($b.键).err.log")" -ForegroundColor DarkYellow }
} else {
  Write-Host "全部就绪 ✅  她的窗口：http://localhost:$WebPort/" -ForegroundColor Green
}
Write-Host "停止全部：.\tools\stop-all.ps1`n"
