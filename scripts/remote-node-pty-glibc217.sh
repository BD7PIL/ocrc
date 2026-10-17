#!/usr/bin/env bash
#
# remote-node-pty-glibc217.sh — 让对端 openchamber 的终端在 glibc 2.17 主机上可用。
#
# 背景：openchamber 的终端走 node-pty 原生模块，官方 prebuild 要求 GLIBC_2.28 与
# GLIBCXX_3.4.21+；RHEL/CentOS 7（glibc 2.17、GLIBCXX 3.4.19）在 dlopen 时失败，
# 面板终端起不来（其余功能不受影响，node-pty 是懒加载）。
#
# 做法（与 BD7PIL/zcode-legacy-glibc 同思路）：在对端用已装的 devtoolset 按宿主 glibc
# 重建 node-pty，-static-libstdc++/-static-libgcc 静态链接，替换
# <node-pty>/prebuilds/linux-x64/pty.node，原文件留 .official-glibc228.bak。
# 不碰系统库、不装 RPM、不改 openchamber 源码；node-pty 版本取自对端已部署的包本身，
# 所以 openchamber 升级后重跑本脚本即可。
#
# 用法：
#   scripts/remote-node-pty-glibc217.sh <ssh-target> [--app-version 2.3.3]
#   scripts/remote-node-pty-glibc217.sh <ssh-target> --verify
#   scripts/remote-node-pty-glibc217.sh <ssh-target> --rollback
#
# <ssh-target> 形如 demo@192.168.26.101，需已配好 key 登录。
# 前置（对端）：devtoolset-9/10/11/12 之一、rh-python38（或 python3 ≥3.8）、binutils(objdump)。
# 注意：换 openchamber 版本（ocrc remote apply）会换掉整棵应用树，补丁需重跑。
set -euo pipefail

usage() {
  sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

TARGET=""
APP_VERSION=""
MODE="apply"
while [ $# -gt 0 ]; do
  case "$1" in
    --app-version) APP_VERSION="${2:-}"; shift 2 ;;
    --verify) MODE="verify"; shift ;;
    --rollback) MODE="rollback"; shift ;;
    -h|--help) usage 0 ;;
    -*) echo "未知参数：$1" >&2; usage 1 ;;
    *) TARGET="$1"; shift ;;
  esac
done
[ -n "$TARGET" ] || usage 1

echo "目标：$TARGET  模式：$MODE${APP_VERSION:+  应用版本：$APP_VERSION}"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" \
  "OCRC_PTY_MODE=$(printf %q "$MODE") OCRC_PTY_APP_VERSION=$(printf %q "$APP_VERSION") bash -s" <<'REMOTE'
set -euo pipefail
MODE="${OCRC_PTY_MODE:-apply}"
APP_VERSION="${OCRC_PTY_APP_VERSION:-}"

REMOTE_ROOT="$HOME/.ocrc/remote"
RUNTIME="$(ls -dt "$REMOTE_ROOT"/runtime/node-* 2>/dev/null | head -1 || true)"
[ -n "$RUNTIME" ] && [ -x "$RUNTIME/bin/node" ] || { echo "找不到对端 Node 运行时（$REMOTE_ROOT/runtime/node-*）" >&2; exit 1; }

if [ -n "$APP_VERSION" ]; then
  APP_DIR="$REMOTE_ROOT/openchamber/$APP_VERSION"
else
  APP_DIR="$(ls -dt "$REMOTE_ROOT"/openchamber/*/ 2>/dev/null | grep -v '\.ocrc-bak' | head -1 || true)"
  APP_DIR="${APP_DIR%/}"
fi
[ -n "$APP_DIR" ] && [ -d "$APP_DIR" ] || { echo "找不到应用树（$REMOTE_ROOT/openchamber/<version>）" >&2; exit 1; }

WEB="$APP_DIR/lib/node_modules/@openchamber/web"
# npm 的布局不保证：全局式安装把依赖嵌在包里，`npm ci` 提升到同级。两处都看。
MODS=""
for d in "$WEB/node_modules" "$APP_DIR/lib/node_modules"; do
  if [ -d "$d/node-pty" ] && [ -d "$d/node-addon-api" ]; then MODS="$d"; break; fi
done
[ -n "$MODS" ] || { echo "找不到 node-pty/node-addon-api（$WEB/node_modules 或 $APP_DIR/lib/node_modules）" >&2; exit 1; }
PKG="$MODS/node-pty"
TARGET_NODE="$PKG/prebuilds/linux-x64/pty.node"
BAK="$TARGET_NODE.official-glibc228.bak"
NPTY_VERSION="$("$RUNTIME/bin/node" -p "require('$PKG/package.json').version")"
echo "  运行时 $("$RUNTIME/bin/node" -v)  应用 $(basename "$APP_DIR")  node-pty $NPTY_VERSION"
echo "  目标 $TARGET_NODE"

check_symbols() {
  local f="$1" ceil refs
  [ -f "$f" ] || { echo "  缺少文件：$f" >&2; return 1; }
  ceil="$(objdump -T "$f" | grep -oE 'GLIBC_2\.[0-9]+(\.[0-9]+)?' | sort -Vu | tail -1)"
  refs="$(objdump -T "$f" | grep -cE 'GLIBCXX_|CXXABI_' || true)"
  echo "  符号上限 $ceil；GLIBCXX/CXXABI 引用 $refs"
  [ "$(printf '%s\n' GLIBC_2.17 "$ceil" | sort -V | tail -1)" = "GLIBC_2.17" ] || { echo "  超出 glibc 2.17 上限" >&2; return 1; }
  [ "$refs" = "0" ] || { echo "  仍有 libstdc++ 动态引用" >&2; return 1; }
}

functional_test() {
  echo "  功能测试：spawn 一个 PTY 并执行命令"
  ( cd "$PKG" && "$RUNTIME/bin/node" -e '
    const pty = require("node-pty");
    const t = pty.spawn("/bin/bash", ["-lc", "echo PTY_OK; tty"], { name: "xterm-color", cols: 100, rows: 30, cwd: process.env.HOME, env: process.env });
    let out = "";
    t.onData((d) => { out += d; });
    t.onExit((e) => { process.stdout.write(out); process.exit(e.exitCode === 0 && out.includes("PTY_OK") ? 0 : 1); });
    setTimeout(() => { console.error("PTY 超时", JSON.stringify(out)); process.exit(2); }, 8000);
  ' )
}

case "$MODE" in
  verify)
    echo "[verify] 检查已安装的 pty.node"
    check_symbols "$TARGET_NODE"
    functional_test
    echo "OK：终端可用"
    ;;
  rollback)
    if [ -f "$BAK" ]; then
      install -m 0644 "$BAK" "$TARGET_NODE"
      rm -f "$BAK"
      echo "OK：已还原官方 prebuild（终端在 glibc 2.17 上会再次不可用）"
    else
      echo "没有可还原的备份（$BAK 不存在）"
    fi
    ;;
  apply)
    DEVTOOLSET=""
    for v in 12 11 10 9; do
      if [ -x "/opt/rh/devtoolset-$v/root/usr/bin/g++" ]; then DEVTOOLSET="$v"; break; fi
    done
    [ -n "$DEVTOOLSET" ] || { echo "找不到 devtoolset-9/10/11/12" >&2; exit 1; }
    PYTHON="/opt/rh/rh-python38/root/usr/bin/python3"
    [ -x "$PYTHON" ] || PYTHON="$(command -v python3 || true)"
    [ -n "$PYTHON" ] || { echo "找不到 python3" >&2; exit 1; }
    NODE_GYP="$RUNTIME/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
    [ -f "$NODE_GYP" ] || { echo "找不到 node-gyp（$NODE_GYP）" >&2; exit 1; }

    WORK="$REMOTE_ROOT/build/node-pty-$NPTY_VERSION-$(date +%Y%m%d%H%M%S)"
    mkdir -p "$WORK/node_modules"
    cp -r "$PKG" "$WORK/node-pty"
    rm -rf "$WORK/node-pty/build" "$WORK/node-pty/prebuilds"
    cp -r "$MODS/node-addon-api" "$WORK/node_modules/node-addon-api"

    echo "[apply] devtoolset-$DEVTOOLSET + $(basename "$PYTHON") 编译 node-pty@$NPTY_VERSION"
    (
      cd "$WORK/node-pty"
      export PATH="/opt/rh/devtoolset-$DEVTOOLSET/root/usr/bin:$RUNTIME/bin:$PATH"
      export CC="/opt/rh/devtoolset-$DEVTOOLSET/root/usr/bin/gcc"
      export CXX="/opt/rh/devtoolset-$DEVTOOLSET/root/usr/bin/g++"
      export CXXFLAGS="-static-libstdc++ -static-libgcc -std=c++17"
      export LDFLAGS="-static-libstdc++ -static-libgcc"
      "$RUNTIME/bin/node" "$NODE_GYP" rebuild --nodedir="$RUNTIME" --python="$PYTHON" > "$WORK/build.log" 2>&1 \
        || { tail -30 "$WORK/build.log" >&2; exit 1; }
    )
    BUILT="$WORK/node-pty/build/Release/pty.node"
    [ -f "$BUILT" ] || { echo "编译未产出 pty.node" >&2; exit 1; }

    [ -f "$BAK" ] || cp -p "$TARGET_NODE" "$BAK"
    install -m 0755 "$BUILT" "$TARGET_NODE"
    echo "[apply] 已替换（原文件备份为 $(basename "$BAK")）"
    check_symbols "$TARGET_NODE"
    functional_test
    echo "OK：终端已修复。重跑本脚本加 --verify；还原加 --rollback（换 openchamber 版本后需重跑）。"
    ;;
  *)
    echo "未知模式：$MODE" >&2; exit 1 ;;
esac
REMOTE
