# PomodoroXII 本地一键启停（后端 8100 + 前端 3010）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev-local.ps1 start
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev-local.ps1 stop
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev-local.ps1 status
#
# 为什么需要这个脚本：由 AI 会话内启动的服务，会话结束后会被回收；
# 用 Start-Process 起的是脱离进程，可以长期存活，但需要一个稳定的停/查入口。

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'restart')]
    [string]$Action = 'status',

    [int]$BackendPort = 8100,
    [int]$FrontendPort = 3010
)

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $PSScriptRoot          # 仓库根
$LogDir = Join-Path $Root '.run-logs'
$Py     = Join-Path $Root 'backend\.venv\Scripts\python.exe'
# ★ 2026-09-12：npm 改为解析式。原硬编码 'E:\WorkBuddyData\...\npm.cmd' 在本机不存在
#   ⇒ start/restart 时前端直接起不来（Start-Process: 系统找不到指定的文件）。
#   另注：必须落到 npm.cmd —— Start-Process 无法直接执行 PATH 上的 npm.ps1。
$NpmCandidates = @(
    (Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1).Source,
    (Join-Path $env:ProgramFiles 'nodejs\npm.cmd'),
    (Join-Path $env:APPDATA 'npm\npm.cmd')
)
$Npm = $NpmCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Npm) {
    $NodeExe = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if ($NodeExe) { $Npm = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd' }
}
if (-not $Npm -or -not (Test-Path $Npm)) {
    throw "npm.cmd 未找到：请安装 Node.js 或将其加入 PATH（解析结果：$Npm）"
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

function Get-PidFile([string]$name) { Join-Path $LogDir "$name.pid" }

function Test-Port([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

function Get-ProcId([string]$name) {
    $f = Get-PidFile $name
    if (Test-Path $f) { return [int](Get-Content -LiteralPath $f -Raw).Trim() }
    return 0
}

# ---------------------------------------------------------------- 健康探针
# 注意 --noproxy '*'：本机常设 HTTP_PROXY，不加会拿到代理的响应。
# 期望值：401 = 后端健康（未带 Authorization 时被正确拒绝）。
function Probe-Backend {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$BackendPort/api/v1/auth/verify" `
            -UseBasicParsing -TimeoutSec 5 -Proxy $null -ErrorAction Stop
        return [int]$r.StatusCode
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

function Show-Status {
    Write-Host ''
    Write-Host 'PomodoroXII 本地服务' -ForegroundColor Cyan
    Write-Host ('-' * 46)

    $bpid = Get-ProcId 'backend'
    $fpid = Get-ProcId 'frontend'
    $bp   = Test-Port $BackendPort
    $fp   = Test-Port $FrontendPort

    $bprobe = Probe-Backend
    $bhealth = if ($bprobe -eq 401) { '健康 (401，符合预期)' }
               elseif ($bprobe -eq 0) { '不可达' }
               else { "异常 HTTP $bprobe" }

    Write-Host ("后端  :{0}  监听={1}  PID={2}  {3}" -f $BackendPort, $bp, $bpid, $bhealth)
    Write-Host ("前端  :{0}  监听={1}  PID={2}" -f $FrontendPort, $fp, $fpid)

    if ($fp) {
        try {
            $rewrite = Invoke-WebRequest -Uri "http://127.0.0.1:$FrontendPort/api/v1/auth/verify" `
                -UseBasicParsing -TimeoutSec 6 -Proxy $null -ErrorAction Stop
            $rw = [int]$rewrite.StatusCode
        } catch {
            $rw = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        }
        $rwText = if ($rw -eq 401) { '转发正常 (401)' }
                  elseif ($rw -eq 500) { '★ 500 = rewrite 目标不可达，检查后端是否在跑' }
                  else { "HTTP $rw" }
        Write-Host ("前端→后端转发      {0}" -f $rwText)
        Write-Host ''
        Write-Host ("打开体验：http://127.0.0.1:{0}" -f $FrontendPort) -ForegroundColor Green
    }
    Write-Host ''
}

function Stop-One([string]$name) {
    $pidFile = Get-PidFile $name
    if (-not (Test-Path $pidFile)) { Write-Host "  $name : 无 PID 文件，跳过"; return }
    $target = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($target -le 0) { Write-Host "  $name : PID 无效，跳过"; return }
    $alive = Get-Process -Id $target -ErrorAction SilentlyContinue
    if (-not $alive) { Write-Host "  $name : PID $target 已不在运行；清理 PID 文件"; Remove-Item $pidFile -Force; return }
    # 连同子进程树一起结束：npm -> next dev 是两级进程
    & taskkill /PID $target /T /F | Out-Null
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host "  $name : 已停止 (PID $target)"
}

function Start-Backend {
    if (Test-Port $BackendPort) { Write-Host "  后端 : 端口 $BackendPort 已被占用，跳过"; return }
    $p = Start-Process -FilePath $Py `
        -ArgumentList '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$BackendPort" `
        -WorkingDirectory (Join-Path $Root 'backend') `
        -RedirectStandardOutput (Join-Path $LogDir 'backend.out.log') `
        -RedirectStandardError  (Join-Path $LogDir 'backend.err.log') `
        -WindowStyle Hidden -PassThru
    $p.Id | Out-File -FilePath (Get-PidFile 'backend') -Encoding ascii
    Write-Host "  后端 : 已启动 PID $($p.Id)  (日志 .run-logs\backend.err.log)"
}

function Start-Frontend {
    if (Test-Port $FrontendPort) { Write-Host "  前端 : 端口 $FrontendPort 已被占用，跳过"; return }
    $env:PATH = (Split-Path $Npm) + ';' + $env:PATH
    $p = Start-Process -FilePath $Npm `
        -ArgumentList 'run', 'dev', '--', '-p', "$FrontendPort" `
        -WorkingDirectory (Join-Path $Root 'frontend') `
        -RedirectStandardOutput (Join-Path $LogDir 'frontend.out.log') `
        -RedirectStandardError  (Join-Path $LogDir 'frontend.err.log') `
        -WindowStyle Hidden -PassThru
    $p.Id | Out-File -FilePath (Get-PidFile 'frontend') -Encoding ascii
    Write-Host "  前端 : 已启动 PID $($p.Id)  (日志 .run-logs\frontend.out.log)"
}

function Wait-Backend {
    Write-Host '  等待后端就绪…' -NoNewline
    for ($i = 0; $i -lt 30; $i++) {
        if ((Probe-Backend) -eq 401) { Write-Host ' 就绪'; return $true }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 2
    }
    Write-Host ' 超时（看 .run-logs\backend.err.log）'
    return $false
}

function Wait-Frontend {
    Write-Host '  等待前端编译…' -NoNewline
    for ($i = 0; $i -lt 40; $i++) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$FrontendPort/" -UseBasicParsing -TimeoutSec 4 -Proxy $null | Out-Null
            Write-Host ' 就绪'; return $true
        } catch {
            if ($_.Exception.Response) { Write-Host ' 就绪'; return $true }
        }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 3
    }
    Write-Host ' 超时（看 .run-logs\frontend.out.log）'
    return $false
}

switch ($Action) {
    'start' {
        Write-Host '启动本地服务…' -ForegroundColor Cyan
        Start-Backend;  Wait-Backend  | Out-Null
        Start-Frontend; Wait-Frontend | Out-Null
        Show-Status
    }
    'stop' {
        Write-Host '停止本地服务…' -ForegroundColor Cyan
        Stop-One 'frontend'
        Stop-One 'backend'
        Write-Host '完成。'
    }
    'restart' {
        & $PSCommandPath stop
        Start-Sleep -Seconds 2
        & $PSCommandPath start
    }
    'status' { Show-Status }
}
