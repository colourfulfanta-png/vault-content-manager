# ============================================================
# Vault 本地一键启动（Windows PowerShell 7 / Windows PowerShell 5.1）
# 用法：在项目根目录运行  pwsh ./start-local.ps1
# 作用：检查 Node → 安装依赖 → 初始化本地 D1 → 启动 http://localhost:8787
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host '=== Vault 本地版启动 ===' -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未检测到 Node.js。请先安装：https://nodejs.org （建议 20 或 22 LTS）'
}
Write-Host ('Node 版本: ' + (node -v))

if (-not (Test-Path 'node_modules')) {
  Write-Host '安装依赖（首次需要几分钟）…'
  npm install
}

Write-Host '初始化本地 D1（表已存在会自动跳过）…'
npx wrangler d1 execute vault --local --config wrangler.local.toml --file schema.sql

Write-Host ''
Write-Host '启动本地服务：http://localhost:8787 （按 Ctrl+C 停止）' -ForegroundColor Green
npx wrangler dev --config wrangler.local.toml
