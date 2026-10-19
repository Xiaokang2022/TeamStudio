$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host ""
Write-Host "TeamStudio · 环境安装" -ForegroundColor Cyan
Write-Host "----------------------------------------"

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "[1/4] 创建 Python 虚拟环境 (.venv)..." -ForegroundColor Yellow
    python -m venv .venv
} else {
    Write-Host "[1/4] 复用已有 Python 虚拟环境" -ForegroundColor Green
}

Write-Host "[2/4] 安装 Python 依赖（清华 PyPI 镜像，含测试依赖）..." -ForegroundColor Yellow
& .\.venv\Scripts\python.exe -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r backend\requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw "Python 依赖安装失败" }

Write-Host "[3/4] 安装前端依赖（npmmirror；清华 npm 镜像已停止提供）..." -ForegroundColor Yellow
npm install --prefix web --registry https://registry.npmmirror.com/
if ($LASTEXITCODE -ne 0) { throw "前端依赖安装失败" }

Write-Host "[4/4] 构建前端静态资源..." -ForegroundColor Yellow
npm run build --prefix web
if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }

Write-Host ""
Write-Host "安装与构建完成。" -ForegroundColor Green
Write-Host "启动命令： .\scripts\start.ps1" -ForegroundColor Cyan
Write-Host "浏览器访问： http://127.0.0.1:8000" -ForegroundColor Cyan
