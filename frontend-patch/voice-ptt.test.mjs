import test from "node:test";
import assert from "node:assert/strict";
import { createPtt, pollPolicy, PTT_DEFAULTS } from "./voice-ptt.mjs";

// 可控时钟
function clock() {
  let t = 1_000_000;
  return { now: () => t, adv: (ms) => (t += ms) };
}

test("按住 2s 松开：提交一次，时长正确", () => {
  const c = clock();
  const evts = [];
  const ptt = createPtt({ now: c.now, onEvent: (e) => evts.push(e) });
  ptt.start(100);
  c.adv(2000);
  const r = ptt.end();
  assert.equal(r.action, "submit");
  assert.equal(r.elapsedMs, 2000);
  assert.deepEqual(evts.map((e) => e.type), ["start", "submit"]);
  assert.equal(ptt.state, "idle");
});

test("松手后重复触发 end 不会二次提交（同一条消息只发一次）", () => {
  const c = clock();
  const evts = [];
  const ptt = createPtt({ now: c.now, onEvent: (e) => evts.push(e) });
  ptt.start(0);
  c.adv(1500);
  ptt.end();
  const again = ptt.end();
  assert.equal(again.action, "ignored");
  assert.equal(evts.filter((e) => e.type === "submit").length, 1);
});

test("上滑超过阈值：取消，不上传", () => {
  const c = clock();
  const evts = [];
  const ptt = createPtt({ now: c.now, onEvent: (e) => evts.push(e) });
  ptt.start(500);
  c.adv(1200);
  ptt.move(500 - PTT_DEFAULTS.cancelSlideUpPx - 5);
  const r = ptt.end();
  assert.equal(r.action, "cancelled");
  assert.equal(evts.some((e) => e.type === "submit"), false);
});

test("滑动未达阈值不算取消", () => {
  const c = clock();
  const ptt = createPtt({ now: c.now });
  ptt.start(500);
  c.adv(1200);
  ptt.move(500 - 10);
  assert.equal(ptt.end().action, "submit");
});

test("pointercancel/切后台：中断丢弃，不自动发送半段", () => {
  const c = clock();
  const evts = [];
  const ptt = createPtt({ now: c.now, onEvent: (e) => evts.push(e) });
  ptt.start(0);
  c.adv(1800);
  const r = ptt.abort("pointercancel");
  assert.equal(r.action, "aborted");
  assert.equal(evts.some((e) => e.type === "submit"), false);
  assert.equal(ptt.state, "idle");
});

test("过短（<300ms）提示重录，不提交", () => {
  const c = clock();
  const evts = [];
  const ptt = createPtt({ now: c.now, onEvent: (e) => evts.push(e) });
  ptt.start(0);
  c.adv(200);
  const r = ptt.end();
  assert.equal(r.action, "tooShort");
  assert.equal(evts.some((e) => e.type === "submit"), false);
});

test("无静音也会在 60s 上限自动结束并提交（替代永不停止的停顿检测）", () => {
  const c = clock();
  const evts = [];
  const ptt = createPtt({ now: c.now, onEvent: (e) => evts.push(e) });
  ptt.start(0);
  c.adv(50_000);
  assert.equal(ptt.tick().action, "recording");
  assert.ok(evts.some((e) => e.type === "warn"), "50s 应发出即将结束提示");
  c.adv(10_000);
  const r = ptt.tick();
  assert.equal(r.action, "submit");
  assert.equal(r.reason, "max-duration");
  assert.equal(ptt.state, "idle");
});

test("到达上限后再次 tick 不会重复提交", () => {
  const c = clock();
  const evts = [];
  const ptt = createPtt({ now: c.now, onEvent: (e) => evts.push(e) });
  ptt.start(0);
  c.adv(60_000);
  ptt.tick();
  ptt.tick();
  assert.equal(evts.filter((e) => e.type === "submit").length, 1);
});

test("轮询策略：两路都终态即停止（修复完成后仍每 3s 轮询）", () => {
  const p = pollPolicy({ turnStatus: "completed", candidates: [{ status: "completed" }, { status: "failed" }] });
  assert.equal(p.poll, false);
});

test("轮询策略：仍在生成时按退避递增", () => {
  assert.equal(pollPolicy({ turnStatus: "generating", candidates: [{ status: "generating" }], attempt: 0 }).delayMs, 1000);
  assert.equal(pollPolicy({ turnStatus: "generating", candidates: [{ status: "generating" }], attempt: 2 }).delayMs, 3000);
  assert.equal(pollPolicy({ turnStatus: "generating", candidates: [{ status: "generating" }], attempt: 9 }).delayMs, 5000);
});

test("轮询策略：页面不可见时不轮询", () => {
  const p = pollPolicy({ turnStatus: "generating", candidates: [{ status: "generating" }], hidden: true });
  assert.equal(p.poll, false);
});
