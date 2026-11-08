#!/bin/sh
# lark-a2a-hub 一行安装：
#   curl -fsSL https://raw.githubusercontent.com/backtomyfuture/lark-a2a-hub/main/install.sh | sh
# 布局：~/.hub-node/ 是配置目录，~/.hub-node/app/ 是程序本体，
#       ~/.local/bin/lah 是主命令入口（hub-node 别名向下兼容）。
# 不在这里种 node.json / commands.json：example 里的占位符和 lan-exec
# 会让随后的 lah setup --yes 拒绝覆盖，或让 doctor 因 carrier 离线失败。
# 正式配置（含绝对路径 echo 种子与本地 Agent 自动扫描）由 lah setup 生成。
# 重跑本脚本 = 更新程序（git pull 或重新下载），已有配置不覆盖。
# 之后的日常更新不必重跑本脚本：lah update（或 lah update --check 先看一眼）做同样的事。
set -eu

SKIP_SKILL="${LAH_SKIP_SKILL:-0}"
for arg in "$@"; do
  case "$arg" in
    --skip-skill)
      SKIP_SKILL=1
      ;;
    -h|--help)
      echo "用法: install.sh [--skip-skill]"
      echo "  --skip-skill  跳过自动安装 ~/.agents/skills/lah（也可设置环境变量 LAH_SKIP_SKILL=1）"
      exit 0
      ;;
  esac
done

REPO_GIT="https://github.com/backtomyfuture/lark-a2a-hub.git"
REPO_TAR="https://codeload.github.com/backtomyfuture/lark-a2a-hub/tar.gz/refs/heads/main"
HOME_DIR="${HUB_NODE_HOME:-$HOME/.hub-node}"
APP="$HOME_DIR/app"

command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js >= 20" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 版本过低（当前 $(node -v)），需要 >= 20" >&2; exit 1; }

mkdir -p "$HOME_DIR"

if [ -d "$APP/.git" ]; then
  echo "更新已有安装…"
  git -C "$APP" pull --ff-only
elif [ -e "$APP" ]; then
  echo "$APP 已存在但不是 git 检出，请先移走它再重跑" >&2
  exit 1
elif command -v git >/dev/null 2>&1; then
  git clone --depth 1 "$REPO_GIT" "$APP"
else
  echo "未找到 git，改用压缩包安装…"
  TMP="$(mktemp -d)"
  curl -fsSL "$REPO_TAR" | tar xz -C "$TMP"
  mv "$TMP"/lark-a2a-hub-main "$APP"
  rm -rf "$TMP"
fi

cd "$APP"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

chmod +x "$APP/bin/lah.mjs" "$APP/bin/hub-node.mjs"
mkdir -p "$HOME/.local/bin"
ln -sf "$APP/bin/lah.mjs" "$HOME/.local/bin/lah"
ln -sf "$APP/bin/lah.mjs" "$HOME/.local/bin/hub-node"

# 自动安装 lah Skill 给终端 Agent 使用（可通过 --skip-skill 或 LAH_SKIP_SKILL=1 跳过）
if [ "$SKIP_SKILL" != "1" ] && [ "$SKIP_SKILL" != "true" ]; then
  mkdir -p "$HOME/.agents/skills/lah"
  if [ -f "$APP/skills/lah/SKILL.md" ]; then
    cp -f "$APP/skills/lah/SKILL.md" "$HOME/.agents/skills/lah/SKILL.md"
  fi
else
  echo "跳过安装 lah Skill（--skip-skill）"
fi

cat <<EOF

安装完成。接下来只需一条命令完成全部配置：
  作为普通节点：                                  lah setup
  作为主枢纽节点（干活 + 审批发卡/结果推送）：lah setup --role hub
（自动装/复用 lark-cli、发现 Base 表、扫描本地 Agent、写好配置并自检；细节见 README）
若 lah 命令找不到，把 \$HOME/.local/bin 加入 PATH。
EOF
