<#
  用 tools/tts-api.env 里的配置启动（线上 TTS）。

  ★ 为什么不把变量直接写在这个脚本里

  那会把 **API key 一起提交到 git**。脚本是要入库的，配置不能入库。
  所以：配置放 `tools/tts-api.env`（已 gitignore），这里只负责读它。
  模板是 `tools/tts-api.env.example`（入库，里面没有真 key）。

  用法：
    .\tools\start-api.cmd
    .\tools\start-api.cmd -Electron     # 想开桌宠窗口就加这个
#>

$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot "tts-api.env"
$example = Join-Path $PSScriptRoot "tts-api.env.example"

if (-not (Test-Path $envFile)) {
  Write-Host ""
  Write-Host "找不到配置文件：$envFile" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "先复制一份模板，填上你的 key：" -ForegroundColor Cyan
  Write-Host "  copy `"$envFile.example`" `"$envFile`"" -ForegroundColor White
  Write-Host ""
  Write-Host "（tts-api.env 在 .gitignore 里，填了 key 也不会被提交）" -ForegroundColor DarkGray
  Write-Host ""
  exit 1
}

<#
  解析 KEY=VALUE。

  故意写得很笨：只认 # 注释、空行、值两侧的引号。
  不做变量展开、不做多行续行、不做 export 前缀 ——
  每多支持一种语法，就多一种「为什么我的值不对」。
  这个文件是给人手写的，不是给机器生成的。
#>
$count = 0
foreach ($raw in (Get-Content $envFile -Encoding UTF8)) {
  $line = $raw.Trim()
  if (-not $line -or $line.StartsWith("#")) { continue }
  $i = $line.IndexOf("=")
  if ($i -le 0) { continue }

  $key = $line.Substring(0, $i).Trim()
  $value = $line.Substring($i + 1).Trim().Trim('"').Trim("'")
  Set-Item -Path "Env:$key" -Value $value
  $count++
}

Write-Host ""
Write-Host "已从 tts-api.env 读入 $count 项配置" -ForegroundColor Cyan

if ($env:NEXUS_TTS_ENGINE) {
  Write-Host "  引擎    ：$env:NEXUS_TTS_ENGINE" -ForegroundColor DarkGray
}
if ($env:NEXUS_TTS_API_URL) {
  Write-Host "  接口    ：$env:NEXUS_TTS_API_URL" -ForegroundColor DarkGray
  Write-Host "  模型    ：$env:NEXUS_TTS_API_MODEL" -ForegroundColor DarkGray
  Write-Host "  音色    ：$env:NEXUS_TTS_API_VOICE" -ForegroundColor DarkGray

  # 只报前后几位 —— 日志和截图里不该出现完整 key
  $key = $env:NEXUS_TTS_API_KEY
  if (-not $key) {
    Write-Host "  API key ：[没填]（openai 引擎必须有）" -ForegroundColor Yellow
  } elseif ($key.Length -gt 12) {
    Write-Host "  API key ：$($key.Substring(0, 6))…$($key.Substring($key.Length - 4))" -ForegroundColor DarkGray
  } else {
    Write-Host "  API key ：（已设置）" -ForegroundColor DarkGray
  }
}

# 音色格式是个高频坑，配错了要到出声那一刻才发现，所以启动时就提醒
if ($env:NEXUS_TTS_ENGINE -eq "openai" -and $env:NEXUS_TTS_API_VOICE -and
    $env:NEXUS_TTS_API_VOICE -notmatch ":") {
  Write-Host ""
  Write-Host "  [注意] 音色要写成「模型名:音色名」，例如：" -ForegroundColor Yellow
  Write-Host "     NEXUS_TTS_API_VOICE=$($env:NEXUS_TTS_API_MODEL):alex" -ForegroundColor Yellow
  Write-Host "     只写 alex 会被服务端拒掉（400 Invalid voice）" -ForegroundColor DarkGray
}

Write-Host ""

& (Join-Path $PSScriptRoot "start-all.ps1") @args
