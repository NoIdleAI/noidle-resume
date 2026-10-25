#!/bin/bash
# NoIdle Resume — macOS 完全卸载脚本（双击运行）
# macOS 拖拽删除 .app 没有「卸载事件」，无法自动清理；此脚本补上：
# 退出 App → 删程序 → 询问后删数据目录。
set -u

APP="/Applications/NoIdle Resume.app"
DATA="$HOME/Library/Application Support/noidle-resume"

echo "== NoIdle Resume 卸载 =="

# 1. 退出正在运行的实例（壳会收割 sidecar，无孤儿进程）
if pgrep -f "NoIdle Resume.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "· 正在退出运行中的 App…"
  osascript -e 'quit app "NoIdle Resume"' >/dev/null 2>&1
  sleep 2
  pkill -f "NoIdle Resume.app/Contents/MacOS" >/dev/null 2>&1 || true
  sleep 1
fi

# 2. 删程序
if [ -d "$APP" ]; then
  rm -rf "$APP" && echo "· 已删除 $APP"
else
  echo "· 未发现 $APP（可能已删除）"
fi

# 3. 询问后删数据（任务历史/登记会话/令牌；默认保留）
if [ -d "$DATA" ]; then
  read -r -p "是否同时删除本机数据（任务历史、登记会话、访问令牌）？[y/N] " ans
  case "$ans" in
    y|Y)
      rm -rf "$DATA" && echo "· 已清理 $DATA"
      ;;
    *)
      echo "· 已保留 $DATA（升级/重装不丢值守记录）"
      ;;
  esac
fi

echo "== 卸载完成 =="
