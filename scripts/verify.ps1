$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "TeamStudio · 后端测试" -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m pytest backend\tests -q
if ($LASTEXITCODE -ne 0) { throw "后端测试失败" }

Write-Host ""
Write-Host "TeamStudio · 前端类型检查与构建" -ForegroundColor Cyan
npm run typecheck --prefix web
if ($LASTEXITCODE -ne 0) { throw "TypeScript 类型检查失败" }
npm run build --prefix web
if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }

Write-Host ""
Write-Host "全部检查通过。" -ForegroundColor Green
