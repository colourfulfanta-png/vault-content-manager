#!/usr/bin/env bash
# ============================================================
# Vault 本地一键启动（macOS / Linux）
# 用法：在项目根目录运行  bash ./start-local.sh
# 作用：检查 Node → 安装依赖 → 初始化本地 D1 → 启动 http://localhost:8787
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Vault 本地版启动 ==="

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装：https://nodejs.org （建议 20 或 22 LTS）"
  exit 1
fi
echo "Node 版本: $(node -v)"

if [ ! -d node_modules ]; then
  echo "安装依赖（首次需要几分钟）…"
  npm install
fi

echo "初始化本地 D1（表已存在会自动跳过）…"
npx wrangler d1 execute vault --local --config wrangler.local.toml --file schema.sql

echo ""
echo "启动本地服务：http://localhost:8787 （按 Ctrl+C 停止）"
npx wrangler dev --config wrangler.local.toml
