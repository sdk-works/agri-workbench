#!/bin/bash
set -euo pipefail

SDK="$HOME/android-sdk"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
APP="/home/ubuntu/agri-android-src/android/app/src/main"
WORK="$HOME/android-build"
# 签名密钥必须放在 WORK 之外：WORK 每次构建都会清空，
# 密钥一旦跟着被删就会生成新密钥，新包与线上签名不一致 → 覆盖安装失败。
KS="$HOME/agri-keystore/qinghe.jks"
# 签名口令不入库，构建前先 export KS_PASS=<口令>
KS_PASS="${KS_PASS:?请先 export KS_PASS=<签名口令>}"

rm -rf "$WORK"
mkdir -p "$WORK"/{gen,obj,dex,out}

# 清单补 package（源码里由 Gradle namespace 提供，aapt2 需要显式包名）
python3 - "$APP/AndroidManifest.xml" "$WORK/AndroidManifest.xml" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
old = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"'
new = old + '\n    package="com.qinghe.app"'
if old not in s:
    raise SystemExit("manifest 根标签未匹配")
open(dst, "w", encoding="utf-8").write(s.replace(old, new, 1))
print("[ok] manifest 注入 package")
PY

echo "== 1/6 编译资源 =="
"$BT/aapt2" compile --dir "$APP/res" -o "$WORK/res.zip"

echo "== 2/6 链接资源清单 =="
"$BT/aapt2" link \
  -o "$WORK/out/base.apk" \
  -I "$PLATFORM" \
  --manifest "$WORK/AndroidManifest.xml" \
  --java "$WORK/gen" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code 15 \
  --version-name 1.15 \
  "$WORK/res.zip"

echo "== 3/6 编译 Java =="
# 不用 -bootclasspath：lambda 需要的 LambdaMetafactory 在 JDK 里，
# android.jar 不含；d8 会把 lambda 脱糖成内部类，min-api 21 也安全。
javac -Xlint:-options -source 8 -target 8 \
  -classpath "$PLATFORM" \
  -encoding UTF-8 -d "$WORK/obj" \
  $(find "$APP/java" "$WORK/gen" -name '*.java')

echo "== 4/6 生成 dex =="
"$BT/d8" --release --min-api 21 --lib "$PLATFORM" \
  --output "$WORK/dex" $(find "$WORK/obj" -name '*.class')

echo "== 5/6 打包 =="
cp "$WORK/out/base.apk" "$WORK/out/unsigned.apk"
python3 - "$WORK/out/unsigned.apk" "$WORK/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
print("[ok] classes.dex 已写入")
PY

echo "== 6/6 对齐与签名 =="
if [ ! -f "$KS" ]; then
  echo "!! 签名密钥不存在：$KS"
  echo "!! 缺失时新包签名会与线上不一致，覆盖安装必然失败，已终止构建。"
  exit 1
fi
echo "-- 复用已有密钥 $KS --"

"$BT/zipalign" -f -p 4 "$WORK/out/unsigned.apk" "$WORK/out/aligned.apk"
"$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias qinghe \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$WORK/out/jingyang-1.15.apk" "$WORK/out/aligned.apk"

echo "== 校验 =="
"$BT/apksigner" verify --print-certs "$WORK/out/jingyang-1.15.apk" | grep -E "SHA-256|Verified using"
echo "-- 清单信息 --"
"$BT/aapt2" dump badging "$WORK/out/jingyang-1.15.apk" | grep -E "^package|application-label|launchable-activity" | head -5
ls -la "$WORK/out/jingyang-1.15.apk"
