$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "TeamStudio · 构建前端" -ForegroundColor Cyan
if (-not (Test-Path "web\node_modules")) {
    Write-Host "未发现 web/node_modules，先安装依赖（npmmirror）..." -ForegroundColor Yellow
    npm install --prefix web --registry https://registry.npmmirror.com/
    if ($LASTEXITCODE -ne 0) { throw "前端依赖安装失败" }
}
npm run build --prefix web
if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
if (-not (Test-Path "web\dist\index.html")) { throw "构建产物 web/dist/index.html 不存在" }
Write-Host "构建完成： web\dist" -ForegroundColor Green
