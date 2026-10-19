param(
    [int]$Port = 8000,
    [switch]$NoBrowser,
    [switch]$Reload
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "尚未安装 Python 环境，请先运行 .\scripts\setup.ps1" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path "web\dist\index.html")) {
    Write-Host "提示：前端尚未构建，当前只能访问 API。可运行 .\scripts\build.ps1" -ForegroundColor Yellow
}

$env:TEAMSTUDIO_DATA_DIR = Join-Path $Root "data"
$Url = "http://127.0.0.1:$Port"
Write-Host ""
Write-Host "TeamStudio 正在启动" -ForegroundColor Cyan
Write-Host "  地址： $Url" -ForegroundColor Green
Write-Host "  文档： $Url/api/docs" -ForegroundColor DarkGray
Write-Host "  数据： $Root\data" -ForegroundColor DarkGray
Write-Host "  停止： Ctrl+C" -ForegroundColor DarkGray
Write-Host ""

if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
        param($target)
        Start-Sleep -Seconds 3
        Start-Process $target
    } -ArgumentList $Url | Out-Null
}

$argsList = @(
    "-m", "uvicorn", "backend.app.main:app",
    "--host", "127.0.0.1",
    "--port", "$Port"
)
if ($Reload) { $argsList += "--reload" }

& .\.venv\Scripts\python.exe @argsList
