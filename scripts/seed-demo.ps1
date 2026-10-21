param(
    [switch]$NoForce
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "尚未安装 Python 环境，请先运行 .\scripts\setup.ps1" -ForegroundColor Red
    exit 1
}

$env:TEAMSTUDIO_DATA_DIR = Join-Path $Root "data"
Write-Host ""
Write-Host "TeamStudio 演示数据写入" -ForegroundColor Cyan
Write-Host "  数据目录： $Root\data" -ForegroundColor DarkGray
Write-Host "  说明： 服务启动不会自动创建演示数据，本脚本需要显式运行。" -ForegroundColor DarkGray
Write-Host "        请在服务停止时执行，避免与运行中的服务争用数据库。" -ForegroundColor DarkGray
Write-Host "        脚本可重复运行：已有数据时不会重复写入（幂等）。" -ForegroundColor DarkGray
if ($NoForce) {
    Write-Host "  模式： 尊重系统重置标记（--no-force），系统重置后不会写入演示数据。" -ForegroundColor DarkGray
} else {
    Write-Host "  模式： 强制写入（忽略系统重置标记，可在系统重置后恢复演示数据）。" -ForegroundColor DarkGray
}
Write-Host ""

$argsList = @("-m", "backend.app.seed")
if ($NoForce) { $argsList += "--no-force" }

& .\.venv\Scripts\python.exe @argsList
$Code = $LASTEXITCODE

Write-Host ""
if ($Code -eq 0) {
    Write-Host "演示数据脚本执行完成。" -ForegroundColor Green
} else {
    Write-Host "演示数据脚本执行失败（退出码 $Code），请检查上方输出。" -ForegroundColor Red
}
exit $Code
