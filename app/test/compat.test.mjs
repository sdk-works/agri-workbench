// 老 Android WebView 兼容性回归
//
// 真实事故：手机上登录直接显示 "AbortSignal.timeout is not a function"。
// 这台机器的 WebView 早于 Chrome 103，没有静态的 AbortSignal.timeout，
// 于是 fetch 的 signal 在参数求值阶段就抛异常，一个字节都没发出去。
//
// 这组测试把 AbortSignal.timeout / AbortSignal.any / crypto.randomUUID 抹掉，
// 模拟那台机器，然后走真实的前端请求路径。

import test from "node:test";
import assert from "node:assert/strict";

const ORIGINAL = {
  timeout: AbortSignal.timeout,
  any: AbortSignal.any,
  randomUUID: globalThis.crypto && globalThis.crypto.randomUUID,
};

function dropModernAbortApi() {
  // 老 WebView 上这几个属性根本不存在
  try {
    delete AbortSignal.timeout;
  } catch (e) {}
  try {
    delete AbortSignal.any;
  } catch (e) {}
  assert.equal(typeof AbortSignal.timeout, "undefined", "AbortSignal.timeout 应已移除");
  assert.equal(typeof AbortSignal.any, "undefined", "AbortSignal.any 应已移除");
}

function restoreModernAbortApi() {
  if (ORIGINAL.timeout) AbortSignal.timeout = ORIGINAL.timeout;
  if (ORIGINAL.any) AbortSignal.any = ORIGINAL.any;
}

test("AbortSignal.timeout 不存在时，登录请求照常发出（不抛 is not a function）", async () => {
  dropModernAbortApi();
  try {
    const { call } = await import("../src/workspace-api.js");
    let seenSignal = "unset";
    globalThis.fetch = async (url, init) => {
      seenSignal = init && init.signal;
      assert.equal(url, "/api/v2/auth/login");
      return new Response(JSON.stringify({ user: { id: "u1", name: "zhb001" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const out = await call("/auth/login", { account: "zhb001", password: "x" });
    assert.equal(out.user.name, "zhb001", "登录结果要能正常解析");
    assert.ok(seenSignal && typeof seenSignal.aborted === "boolean", "必须仍然带上 signal");
  } finally {
    restoreModernAbortApi();
  }
});

test("超时会被识别成「超时」，不是「取消」", async () => {
  dropModernAbortApi();
  try {
    const { call } = await import("../src/workspace-api.js");
    globalThis.fetch = (url, init) =>
      new Promise((resolve, reject) => {
        // 永不返回，只等 signal 中断
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      });
    // 10ms 就超时：验证的是计时器真的在跑，不是原生 API
    await assert.rejects(
      () => call("/auth/login", {}, "POST", { timeoutMs: 10 }),
      (e) => {
        assert.equal(e.timeout, true, "应标记为超时");
        assert.equal(e.canceled, undefined, "不应标记为取消");
        assert.match(e.message, /超时/, "提示要能看懂");
        assert.doesNotMatch(e.message, /is not a function/, "不能把 JS 异常透给用户");
        return true;
      },
    );
  } finally {
    restoreModernAbortApi();
  }
});

test("调用方主动取消会被识别成「取消」，不是「超时」", async () => {
  dropModernAbortApi();
  try {
    const { call } = await import("../src/workspace-api.js");
    const ac = new AbortController();
    globalThis.fetch = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const p = call("/turns", {}, "POST", { timeoutMs: 60000, signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await assert.rejects(
      () => p,
      (e) => {
        assert.equal(e.canceled, true, "应标记为取消");
        assert.equal(e.timeout, undefined, "不应标记为超时");
        assert.match(e.message, /取消/);
        return true;
      },
    );
  } finally {
    restoreModernAbortApi();
  }
});

test("请求结束后计时器与监听都被清掉（不会迟到触发、不会泄漏）", async () => {
  dropModernAbortApi();
  try {
    const { timeoutSignal } = await import("../src/compat.js");
    const ac = new AbortController();
    const t = timeoutSignal(30, ac.signal);
    assert.equal(t.signal.aborted, false);
    t.cleanup();
    // 清理之后，即使外部还 abort，也不该再联动
    const wasAborted = t.signal.aborted;
    ac.abort();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(wasAborted, false);
    assert.equal(t.timedOut(), false, "超时标志不该在 cleanup 后翻起来");
  } finally {
    restoreModernAbortApi();
  }
});

test("compat.js 在没有任何新 API 时也能加载并给出探测结果", async () => {
  dropModernAbortApi();
  try {
    const compat = await import("../src/compat.js");
    const probe = compat.compatProbe();
    assert.equal(probe.abortTimeout, false, "探测要如实说没有 timeout");
    assert.equal(probe.abortAny, false, "探测要如实说没有 any");
    assert.equal(probe.abortController, true, "AbortController 本身是有的");
    // 没有 timeout 也要能造出 signal
    const t = compat.timeoutSignal(1000);
    assert.ok(t.signal instanceof AbortSignal);
    t.cleanup();
  } finally {
    restoreModernAbortApi();
  }
});

test("uuid() 在没有 crypto.randomUUID 时仍返回合法 v4", async () => {
  const cryptoObj = globalThis.crypto;
  const hadOwn = cryptoObj && Object.getOwnPropertyDescriptor(cryptoObj, "randomUUID");
  try {
    // randomUUID 在 WebCrypto 原型上，delete 删不掉，必须盖成 undefined
    if (cryptoObj) {
      Object.defineProperty(cryptoObj, "randomUUID", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      assert.notEqual(typeof cryptoObj.randomUUID, "function", "要模拟出「没有」的状态");
    }
    const { uuid } = await import("../src/compat.js");
    const id = uuid();
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      "必须是合法 v4 UUID：" + id,
    );
    assert.notEqual(uuid(), id, "两次不能相同");
  } finally {
    if (cryptoObj) {
      if (hadOwn) Object.defineProperty(cryptoObj, "randomUUID", hadOwn);
      else delete cryptoObj.randomUUID;
    }
  }
});

test("friendlyError 不把 JavaScript 异常原文摆给用户", async () => {
  const { friendlyError } = await import("../src/compat.js");
  const jsErr = friendlyError(
    new TypeError("AbortSignal.timeout is not a function"),
  );
  assert.doesNotMatch(jsErr, /is not a function/, "不能出现 JS 异常原文");
  assert.match(jsErr, /WebView|版本|App/, "要告诉用户怎么办");

  assert.match(friendlyError(Object.assign(new Error("x"), { timeout: true })), /超时/);
  assert.match(friendlyError(Object.assign(new Error("x"), { canceled: true })), /取消/);
  assert.match(friendlyError(new TypeError("Failed to fetch")), /网络/);

  // 业务错误（服务端给的说明）要原样保留，不能被吃掉
  assert.equal(friendlyError(new Error("密码错误")), "密码错误");
});
