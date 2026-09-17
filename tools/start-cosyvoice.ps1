<#
  启动 CosyVoice 2 服务（用你自己的音色说话）。

  为什么要有这个脚本：CosyVoice 跑在**自己的环境**里（D:\cosyvoice\.venv，
  Python 3.10 + torch cu121，约 7GB），和项目的 python\.venv 不是一套。
  每次手敲那一长串路径 + 环境变量太容易错，所以包一层。

  用法：
      .\tools\start-cosyvoice.ps1              # 默认端口 8788
      .\tools\start-cosyvoice.ps1 -Port 8790
      .\tools\start-cosyvoice.ps1 -Fp32        # 关 fp16（一般不用）

  模型加载要 10~15 秒，加载完会打印「就绪」。
#>
param(
  [int]$Port = 8788,
  [switch]$Fp32
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # 项目根
$cosy = if ($env:NEXUS_COSY_ROOT) { $env:NEXUS_COSY_ROOT } else { "D:\cosyvoice" }
$py = Join-Path $cosy ".venv\Scripts\python.exe"
$server = Join-Path $root "python\cosyvoice_server.py"

if (-not (Test-Path $py)) {
  Write-Host "找不到 CosyVoice 的 Python 环境：$py" -ForegroundColor Red
  Write-Host "（如果它不在 D:\cosyvoice，设一下 `$env:NEXUS_COSY_ROOT）"
  exit 1
}
if (-not (Test-Path $server)) {
  Write-Host "找不到服务脚本：$server" -ForegroundColor Red
  exit 1
}

$env:NEXUS_COSY_PORT = "$Port"
$env:PYTHONIOENCODING = "utf-8"   # 中文日志别乱码
if ($Fp32) { $env:NEXUS_COSY_FP32 = "1" }

$voices = Join-Path $root "python\voices"
if (Test-Path $voices) {
  $wavs = @(Get-ChildItem $voices -Filter *.wav -ErrorAction SilentlyContinue)
  if ($wavs.Count -gt 0) {
    Write-Host "找到 $($wavs.Count) 个音色：$($wavs.BaseName -join ', ')" -ForegroundColor Green
  } else {
    Write-Host "python\voices 里还没有 .wav —— 会先用自带示例音色（default）" -ForegroundColor Yellow
    Write-Host "  想用自己的声音：录 5~10 秒念一句话，存成 <名字>.wav + <名字>.txt（那句话的文字）"
  }
}

$args = @($server, "--port", "$Port")
if ($Fp32) { $args += "--fp32" }

Write-Host "启动 CosyVoice 2（模型加载约 10~15 秒）…" -ForegroundColor Cyan
& $py @args
