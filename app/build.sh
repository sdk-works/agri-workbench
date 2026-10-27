#!/bin/sh
# 构建前端。系统 PATH 里没有 node，必须用 runtime 内置的；vite 装在 toolchain。
# 用法：./build.sh            产物进 dist/
#      ./build.sh --outDir /tmp/x --emptyOutDir
set -e
cd "$(dirname "$0")" || exit 1

NODE=../runtime/node/bin/node
[ -x "$NODE" ] || NODE=$(command -v node)
if [ -z "$NODE" ]; then
  echo "找不到 node：既没有 ../runtime/node/bin/node，PATH 里也没有" >&2
  exit 1
fi

VITE=../toolchain/node_modules/vite/bin/vite.js
if [ ! -f "$VITE" ]; then
  echo "找不到 vite：$VITE" >&2
  echo "toolchain 缺失时先装：npm i --prefix ../toolchain vite@6 @vitejs/plugin-vue@5" >&2
  exit 1
fi

exec "$NODE" "$VITE" build "$@"
