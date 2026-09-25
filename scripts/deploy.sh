#!/bin/bash
# 把本仓库同步到线上部署目录并重启桥（macOS / Linux）
#
#   ./scripts/deploy.sh           同步 + 校验 + 重启
#   ./scripts/deploy.sh --check   只比对差异，不做改动（有差异时退出码 1）
#
# 部署目录默认 ~/opencode-feishu-bridge，可用 OFBS_DEPLOY_DIR 覆盖。
# 同步范围：dist/ bin/ scripts/ skills/ examples/ 与若干根文件；不含 .git 与 node_modules。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${OFBS_DEPLOY_DIR:-$HOME/opencode-feishu-bridge}"
CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1
fi

ITEMS=(dist bin scripts skills examples package.json config.example.json README.md CHANGELOG.md LICENSE .gitignore)

if [ ! -d "$DEPLOY_DIR/dist" ]; then
  echo "部署目录看起来不对：$DEPLOY_DIR" >&2
  exit 1
fi

echo "仓库：$REPO_ROOT"
echo "部署：$DEPLOY_DIR"
if [ "$CHECK" = "1" ]; then
  echo "模式：只比对（--check）"
fi
echo

changed=0
for item in "${ITEMS[@]}"; do
  src="$REPO_ROOT/$item"
  [ -e "$src" ] || continue
  if [ -d "$src" ]; then
    while IFS= read -r rel; do
      rel="${rel#./}"
      target="$DEPLOY_DIR/$item/$rel"
      if [ ! -f "$target" ] || ! cmp -s "$src/$rel" "$target"; then
        changed=$((changed + 1))
        if [ "$CHECK" = "1" ]; then
          echo "  需要更新  $item/$rel"
        else
          mkdir -p "$(dirname "$target")"
          cp -p "$src/$rel" "$target"
          echo "  更新      $item/$rel"
        fi
      fi
    done < <(cd "$src" && find . -type f)
  else
    target="$DEPLOY_DIR/$item"
    if [ ! -f "$target" ] || ! cmp -s "$src" "$target"; then
      changed=$((changed + 1))
      if [ "$CHECK" = "1" ]; then
        echo "  需要更新  $item"
      else
        cp -p "$src" "$target"
        echo "  更新      $item"
      fi
    fi
  fi
done

if [ "$changed" = "0" ]; then
  echo "  无差异"
  exit 0
fi

if [ "$CHECK" = "1" ]; then
  echo
  echo "共 $changed 个文件有差异；运行 ./scripts/deploy.sh 同步"
  exit 1
fi

echo
echo "校验 dist/ 与 bin/ ..."
for f in "$REPO_ROOT"/dist/*.js "$REPO_ROOT"/bin/*.js; do
  rel="${f#$REPO_ROOT/}"
  if ! cmp -s "$f" "$DEPLOY_DIR/$rel"; then
    echo "  校验失败：$rel" >&2
    exit 1
  fi
done
echo "  一致"

PID="$(pgrep -f "$DEPLOY_DIR/dist/main.js" | head -1 || true)"
if [ -z "$PID" ]; then
  echo
  echo "未发现运行中的桥（可能未由 launchd/systemd 托管），跳过重启"
  exit 0
fi

echo
echo "重启桥 pid=$PID ..."
kill -TERM "$PID" 2>/dev/null || true
NEW=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  NEW="$(pgrep -f "$DEPLOY_DIR/dist/main.js" | head -1 || true)"
  if [ -n "$NEW" ] && [ "$NEW" != "$PID" ]; then
    echo "新 pid=$NEW"
    break
  fi
done
if [ -z "$NEW" ] || [ "$NEW" = "$PID" ]; then
  echo "桥尚未重新起来，请检查日志" >&2
fi

LOG="$HOME/.launchd-logs/ofbs.log"
if [ -f "$LOG" ]; then
  echo
  echo "最近日志："
  tail -n 6 "$LOG"
fi
