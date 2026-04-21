#!/bin/bash
# LynLens 一键重启 — 双击即可
# 会:1) 杀掉所有旧的 LynLens dev 进程 (electron / vite / tsc / concurrently)
#      2) 启动 pnpm --filter @lynlens/desktop dev
#      3) 保持终端打开,按 Ctrl+C 两次退出

set -e

# 切到本脚本所在目录(项目根)
cd "$(dirname "$0")"

echo "========================================="
echo " LynLens 重启中..."
echo "========================================="
echo

# ---- 1) 杀旧进程 ----
# 只杀和本项目相关的,不影响其它 Electron 应用。
echo "[1/2] 停止旧的 dev 进程..."

PROJECT_PATH="$(pwd)"

# pkill -f 用完整命令行匹配;|| true 防止没找到时脚本退出
pkill -f "concurrently.*pnpm dev:renderer" 2>/dev/null || true
pkill -f "$PROJECT_PATH.*vite"            2>/dev/null || true
pkill -f "$PROJECT_PATH.*electron"        2>/dev/null || true
pkill -f "$PROJECT_PATH.*tsc -p tsconfig.main" 2>/dev/null || true
pkill -f "wait-on http://localhost:5173"  2>/dev/null || true

# 等一下让子进程彻底退
sleep 1

# 确认 5173 端口空了(vite 偶尔会留着)
if lsof -ti:5173 >/dev/null 2>&1; then
  echo "  端口 5173 还被占用,强制释放..."
  lsof -ti:5173 | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "  ✓ 旧进程已清理"
echo

# ---- 2) 启动 dev ----
echo "[2/2] 启动 LynLens dev..."
echo "  (几秒后 Electron 窗口会弹出;按两次 Ctrl+C 退出)"
echo

exec pnpm --filter @lynlens/desktop dev
