// 页面来源校验的单元测试。
//
// 背景（2026-10-28）：为了让手机不用装根证书就能用麦克风和相机，接了
// Cloudflare Tunnel，其 quick tunnel 域名每次重启都变，所以 ALLOWED_ORIGINS
// 需要支持 https://*.trycloudflare.com 这种通配。
//
// 第一版通配实现把 * 用 /^\\*/ 去掉前缀 —— 但通配符在中间（https://*.xxx），
// 结果得到 "https://.trycloudflare.com"，永远匹配不上，所有隧道来源全被 403。
// 这个 bug 在真机链路测试里才暴露出来。这里把各种边界都钉死。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOriginMatcher } from "./origin-guard.mjs";

const list = [
  "http://127.0.0.1:8080",
  "https://42.193.104.148",
  "https://*.trycloudflare.com",
];

test("精确匹配的来源放行", () => {
  const ok = buildOriginMatcher(list);
  assert.equal(ok("http://127.0.0.1:8080"), true);
  assert.equal(ok("https://42.193.104.148"), true);
});

test("未列出的来源拒绝", () => {
  const ok = buildOriginMatcher(list);
  assert.equal(ok("https://evil.example.com"), false);
  assert.equal(ok("http://42.193.104.148"), false, "协议不同不算同一个来源");
  assert.equal(ok("https://42.193.104.148:8443"), false, "端口不同不算同一个来源");
});

test("通配符在中间时能匹配（回归：曾实现成去前缀导致永不命中）", () => {
  const ok = buildOriginMatcher(list);
  assert.equal(
    ok("https://humanity-essentials-trips-constantly.trycloudflare.com"),
    true,
  );
  assert.equal(ok("https://else-bowling-lenses-admitted.trycloudflare.com"), true);
});

test("通配不放行相似域名", () => {
  const ok = buildOriginMatcher(list);
  assert.equal(ok("https://trycloudflare.com"), false, "通配符要求至少一段前缀");
  assert.equal(ok("https://a.trycloudflare.com.evil.com"), false);
  assert.equal(ok("https://evil.com/x.trycloudflare.com"), false);
  assert.equal(ok("http://abc.trycloudflare.com"), false, "通配项写的是 https，不能放行 http");
});

test("没有 Origin 头不拦（curl、同源导航）", () => {
  const ok = buildOriginMatcher(list);
  assert.equal(ok(""), true);
  assert.equal(ok(undefined), true);
});

test("空配置时只放行无 Origin 的请求", () => {
  const ok = buildOriginMatcher("");
  assert.equal(ok(""), true);
  assert.equal(ok("https://anything.example.com"), false);
});

test("数组与逗号串两种写法等价", () => {
  const a = buildOriginMatcher(["https://*.trycloudflare.com"]);
  const b = buildOriginMatcher("https://*.trycloudflare.com");
  assert.equal(a("https://x.trycloudflare.com"), true);
  assert.equal(b("https://x.trycloudflare.com"), true);
  assert.equal(a("https://x.other.com"), false);
  assert.equal(b("https://x.other.com"), false);
});

test("配置里的空格不影响匹配", () => {
  const ok = buildOriginMatcher(" https://42.193.104.148 , https://*.trycloudflare.com ");
  assert.equal(ok("https://42.193.104.148"), true);
  assert.equal(ok("https://x.trycloudflare.com"), true);
});
