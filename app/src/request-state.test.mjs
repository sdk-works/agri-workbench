// 故障注入：请求状态机与轮询调度
//
// 这四个场景对应线上真实出现的形态（2026-10-29 上午）：
//   挂起请求、响应丢失、迟到返回、单路失败；外加一条「停止按钮被 busy 锁住」。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SEND,
  TIMEOUTS,
  nextPollDelay,
  isDefiniteFailure,
  cancelEnabled,
  createSendTracker,
  createPollScheduler,
} from "./request-state.mjs";

function newDraft(q = "种植番茄需要注意什么") {
  return { request_id: "req-0001-abcd", question: q, conversation_id: "" };
}

test("挂起请求：超时进入待确认，draft 与 request_id 必须留着", () => {
  const seen = [];
  const tracker = createSendTracker({ onChange: (s) => seen.push(s.phase) });
  const draft = newDraft();
  const token = tracker.begin(draft, 1);

  assert.equal(tracker.phase, SEND.SENDING);
  const verdict = tracker.markUnconfirmed(token, 1, "服务器响应超时");
  assert.equal(verdict, "unconfirmed");
  assert.equal(tracker.phase, SEND.UNCONFIRMED);
  assert.deepEqual(tracker.state.draft, draft, "draft 留着才能用同一个 request_id 对账");
  assert.equal(tracker.state.attempts, 2);
  assert.deepEqual(seen, [SEND.SENDING, SEND.UNCONFIRMED]);
});

test("对账成功（服务端返回 duplicate）：放开锁并丢弃 draft", () => {
  const tracker = createSendTracker();
  const token = tracker.begin(newDraft(), 1);
  tracker.markUnconfirmed(token, 1, "断网");
  assert.equal(tracker.confirm(token, 1), "confirmed");
  assert.equal(tracker.phase, SEND.IDLE);
  assert.equal(tracker.state.draft, null, "已确认就不能再拿旧 draft 重发");
});

test("明确失败（4xx）：不会建轮次，直接放开并丢弃 draft", () => {
  const tracker = createSendTracker();
  const token = tracker.begin(newDraft(), 1);
  assert.equal(tracker.fail(token, 1), "failed");
  assert.equal(tracker.phase, SEND.IDLE);
  assert.equal(tracker.state.draft, null);
});

test("迟到返回：切会话后旧响应既不填新会话，也不解锁新请求", () => {
  const tracker = createSendTracker();
  const oldToken = tracker.begin(newDraft("旧问题"), 1);

  // 用户切到新会话：epoch +1，作废在途提交
  tracker.reset(2);
  assert.equal(tracker.phase, SEND.IDLE);

  // 新会话里又发了一条
  const newToken = tracker.begin(newDraft("新问题"), 2);
  assert.equal(tracker.phase, SEND.SENDING);

  // 旧请求这时才回来
  assert.equal(tracker.confirm(oldToken, 2), "stale", "旧响应不能确认新提交");
  assert.equal(tracker.phase, SEND.SENDING, "旧请求的 finally 不能把新请求解锁");

  // 旧请求带着旧 epoch 回来同样是 stale
  assert.equal(tracker.confirm(oldToken, 1), "stale");
  assert.equal(tracker.state.draft.question, "新问题");

  assert.equal(tracker.confirm(newToken, 2), "confirmed");
  assert.equal(tracker.phase, SEND.IDLE);
});

test("停止按钮：生成中可点，取消中只禁用这一轮", () => {
  assert.equal(cancelEnabled({ status: "generating", cancelingId: "", turnId: "t1" }), true);
  assert.equal(cancelEnabled({ status: "generating", cancelingId: "t1", turnId: "t1" }), false);
  assert.equal(cancelEnabled({ status: "generating", cancelingId: "t1", turnId: "t2" }), true);
  assert.equal(cancelEnabled({ status: "completed", cancelingId: "", turnId: "t1" }), false);
});

test("错误分类：超时/断网/5xx 都不算明确失败", () => {
  assert.equal(isDefiniteFailure({ status: 409 }), true);
  assert.equal(isDefiniteFailure({ status: 400 }), true);
  assert.equal(isDefiniteFailure({ status: 408 }), false);
  assert.equal(isDefiniteFailure({ status: 429 }), false);
  assert.equal(isDefiniteFailure({ status: 500 }), false);
  assert.equal(isDefiniteFailure({ status: 0, timeout: true }), false);
  assert.equal(isDefiniteFailure(Object.assign(new Error("Failed to fetch"))), false);
});

test("轮询：弱网退避到 30 秒封顶，恢复后回到 3 秒", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map((n) => nextPollDelay(n)),
    [3000, 6000, 12000, 24000, 30000, 30000, 30000],
  );
});

test("轮询调度：请求没回来时不再叠一发，失败后拉长间隔，成功清零", async () => {
  const timers = [];
  let resolveRun;
  let runCount = 0;
  const scheduler = createPollScheduler({
    run: () => {
      runCount += 1;
      return new Promise((r) => {
        resolveRun = r;
      });
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });

  scheduler.start();
  assert.equal(timers.at(-1).ms, 3000, "第一拍就是基础间隔");

  // 第一拍开始，请求挂住
  const first = timers.at(-1).fn();
  assert.equal(scheduler.inflight, true);
  assert.equal(runCount, 1);

  // 挂住期间又来一拍：直接跳过，不排队、不发第二个请求
  timers.at(-1).fn();
  assert.equal(runCount, 1, "同一时刻只能有一个轮询请求在飞");

  resolveRun();
  await first;
  assert.equal(scheduler.inflight, false);
  assert.equal(timers.at(-1).ms, 3000, "成功了回到基础间隔");
});

test("轮询调度：连续失败按 3→6→12 秒退避", async () => {
  const timers = [];
  let fail = false;
  const scheduler = createPollScheduler({
    run: async () => {
      if (fail) throw new Error("Failed to fetch");
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });

  scheduler.start();
  fail = true;
  await timers.at(-1).fn();
  assert.equal(timers.at(-1).ms, 6000);
  await timers.at(-1).fn();
  assert.equal(timers.at(-1).ms, 12000);
  await timers.at(-1).fn();
  assert.equal(timers.at(-1).ms, 24000);

  fail = false;
  await timers.at(-1).fn();
  assert.equal(timers.at(-1).ms, 3000, "恢复后立刻回到 3 秒");
});

test("超时常量：启动探测必须比提交短，避免白屏一分钟", () => {
  assert.ok(TIMEOUTS.boot <= 15000);
  assert.ok(TIMEOUTS.boot < TIMEOUTS.send);
  assert.ok(TIMEOUTS.cancel <= TIMEOUTS.send);
});
