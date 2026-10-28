#!/bin/sh
# 构建前端。系统 PATH 里没有 node，必须用 runtime 内置的；vite 装在 toolchain。
# 用法：./build.sh            产物进 dist/
#      ./build.sh --outDir /tmp/x --emptyOutDir
#
# 构建完会写 dist/build.json（提交号 + 构建时间 + 工作区是否干净）。
# 服务端 /api/v2/version 读它，用来回答"线上这版是哪个提交建的"。
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

"$NODE" "$VITE" build "$@"

# 出了自定义 outDir 就按约定不写指纹（调用方要的是临时产物）
case " $* " in
  *" --outDir "*|*" --outDir="*) exit 0 ;;
esac

COMMIT=$(git -C .. rev-parse --short HEAD 2>/dev/null || echo unknown)
DIRTY=$(git -C .. status --porcelain 2>/dev/null | wc -l | tr -d ' ')
BUILT_AT=$(date -Iseconds)
JS=$(ls dist/assets/index-*.js 2>/dev/null | head -1 | sed 's|^dist/||')
CSS=$(ls dist/assets/index-*.css 2>/dev/null | head -1 | sed 's|^dist/||')
cat > dist/build.json <<EOF
{"commit":"$COMMIT","dirty":$DIRTY,"builtAt":"$BUILT_AT","js":"$JS","css":"$CSS"}
EOF
echo "构建指纹 dist/build.json: $COMMIT dirty=$DIRTY $JS"
