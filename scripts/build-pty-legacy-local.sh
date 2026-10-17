#!/usr/bin/env bash
#
# build-pty-legacy-local.sh — rebuild node-pty against the host's glibc on a
# Linux build host (CI container / EL7 target). This is the local counterpart of
# `remote-node-pty-glibc217.sh`: same recipe, no ssh.
#
# Usage:
#   scripts/build-pty-legacy-local.sh --tree <app-tree> --node-dir <node-prefix> --out <pty.node>
#
# <app-tree>   the npm prefix that contains lib/node_modules/@openchamber/web
# <node-prefix> a Node install with include/node + npm's bundled node-gyp
#              (e.g. the glibc-217 runtime we ship)
#
# Requires: devtoolset-9/10/11/12 (or a C++17 compiler), python3 >= 3.8,
# make, binutils. Does not touch system libraries; the output links
# libstdc++/libgcc statically and stays within glibc 2.17 symbols.
set -euo pipefail

TREE=""; NODE_DIR=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tree) TREE="${2:-}"; shift 2 ;;
    --node-dir) NODE_DIR="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$TREE" ] && [ -n "$NODE_DIR" ] && [ -n "$OUT" ] || { echo "usage: $0 --tree TREE --node-dir NODE --out FILE" >&2; exit 1; }
[ -x "$NODE_DIR/bin/node" ] || { echo "node not found: $NODE_DIR/bin/node" >&2; exit 1; }

APP="$TREE/lib/node_modules/@openchamber/web"
# npm's layout is not guaranteed: a global-style install nests deps under the
# package, `npm ci` hoists them beside it. Both resolve at runtime.
MODS=""
for d in "$APP/node_modules" "$TREE/lib/node_modules"; do
  if [ -d "$d/node-pty" ] && [ -d "$d/node-addon-api" ]; then MODS="$d"; break; fi
done
[ -n "$MODS" ] || { echo "node-pty/node-addon-api not found under $APP/node_modules or $TREE/lib/node_modules" >&2; exit 1; }
PKG="$MODS/node-pty"
ADDON="$MODS/node-addon-api"

DEVTOOLSET=""
for v in 12 11 10 9; do
  if [ -x "/opt/rh/devtoolset-$v/root/usr/bin/g++" ]; then DEVTOOLSET="$v"; break; fi
done
[ -n "$DEVTOOLSET" ] || { echo "no devtoolset found (need C++17)" >&2; exit 1; }
PYTHON=""
for p in /opt/rh/rh-python38/root/usr/bin/python3 /opt/rh/rh-python38/root/usr/bin/python3.8 /opt/python/cp38-cp38/bin/python3; do
  [ -x "$p" ] && { PYTHON="$p"; break; }
done
[ -n "$PYTHON" ] || PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || { echo "no python3" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/node_modules"
cp -r "$PKG" "$WORK/node-pty"
rm -rf "$WORK/node-pty/build" "$WORK/node-pty/prebuilds"
cp -r "$ADDON" "$WORK/node_modules/node-addon-api"

echo "[pty] devtoolset-$DEVTOOLSET + $("$PYTHON" -V 2>&1) + $("$NODE_DIR/bin/node" -v)"
cd "$WORK/node-pty"
export PATH="/opt/rh/devtoolset-$DEVTOOLSET/root/usr/bin:$NODE_DIR/bin:$PATH"
export CC="/opt/rh/devtoolset-$DEVTOOLSET/root/usr/bin/gcc"
export CXX="/opt/rh/devtoolset-$DEVTOOLSET/root/usr/bin/g++"
export CXXFLAGS="-static-libstdc++ -static-libgcc -std=c++17"
export LDFLAGS="-static-libstdc++ -static-libgcc"
"$NODE_DIR/bin/node" "$NODE_DIR/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js" rebuild \
  --nodedir="$NODE_DIR" --python="$PYTHON" > "$WORK/build.log" 2>&1 \
  || { tail -40 "$WORK/build.log" >&2; exit 1; }

BUILT="$WORK/node-pty/build/Release/pty.node"
[ -f "$BUILT" ] || { echo "node-gyp produced no pty.node" >&2; exit 1; }
install -m 0755 "$BUILT" "$OUT"

CEIL="$(objdump -T "$OUT" | grep -oE 'GLIBC_2\.[0-9]+(\.[0-9]+)?' | sort -Vu | tail -1)"
REFS="$(objdump -T "$OUT" | grep -cE 'GLIBCXX_|CXXABI_' || true)"
echo "[pty] GLIBC ceiling $CEIL; GLIBCXX/CXXABI refs $REFS"
[ "$(printf '%s\n' GLIBC_2.17 "$CEIL" | sort -V | tail -1)" = "GLIBC_2.17" ] || { echo "exceeds glibc 2.17" >&2; exit 1; }
[ "$REFS" = "0" ] || { echo "still references libstdc++ dynamically" >&2; exit 1; }
"$NODE_DIR/bin/node" -e "require(process.argv[1]); console.log('[pty] loads OK')" "$OUT"
echo "$OUT"
