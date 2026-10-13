import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";
import { createGateway } from "./model-gateway.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// AbortSignal.timeout 的计时器是 unref 的，不保持事件循环；
// 挂起测试期间需一个 ref 定时器防止 node:test 误判 event loop 已清空而取消。
function keepAlive(ms = 8000) {
  const iv = setInterval(() => {}, 1000);
  const to = setTimeout(() => clearInterval(iv), ms);
  return () => {
    clearInterval(iv);
    clearTimeout(to);
  };
}
const answer = (role, extra = {}) => ({
  answer: role + " 答案",
  model: role + "-model",
  provider: role === "local" ? "local" : "cloud",
  usage: { input_tokens: 5, output_tokens: 5 },
  ...extra,
});
const enc = (s) => new TextEncoder().encode(s);
const abortError = () => new DOMException("The operation was aborted.", "AbortError");
function hangingFetcher(capture = {}) {
  return (url, opts) =>
    new Promise((resolve, reject) => {
      capture.signal = opts?.signal;
      if (opts?.signal?.aborted) return reject(abortError());
      opts?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
}
function streamRes(chunks) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        let i = 0;
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
          cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}
function gw(fetcher, limits = {}) {
  return createGateway(
    { LOCAL_MODEL: "test-model", ZHIPU_API_KEY: "test-key" },
    undefined,
    { fetcher, limits: { localConcurrency: 2, cloudConcurrency: 2, localTimeoutMs: 400, cloudTimeoutMs: 400, ...limits } },
  );
}

test("P1-1 组合取消：外部取消优先于超时，抛 canceled", async () => {
  const f = hangingFetcher();
  const g = gw(f, { localTimeoutMs: 60000 });
  const ctrl = new AbortController();
  const p = g.call("local", [{ role: "user", content: "hi" }], false, undefined, undefined, {
    signal: ctrl.signal,
  });
  await sleep(20);
  ctrl.abort();
  await assert.rejects(p, (e) => e.code === "canceled");
});

test("P1-1 超时生效：无外部 signal 时按 timeoutMs 抛 timeout", async () => {
  const ka = keepAlive();
  try {
    const f = hangingFetcher();
    const g = gw(f, { localTimeoutMs: 250 });
    const started = Date.now();
    await assert.rejects(
      g.call("local", [{ role: "user", content: "hi" }]),
      (e) => e.code === "timeout",
    );
    assert.ok(Date.now() - started >= 180, "应等待到超时点");
  } finally {
    ka();
  }
});

test("P2-4 流式 EOF 残余：末尾 done=true 无换行判为完整", async () => {
  const chunks = [enc('{"message":{"content":"你好"}}\n'), enc('{"done":true}')];
  const g = gw(() => streamRes(chunks));
  const out = await g.call("local", [{ role: "user", content: "hi" }], false, undefined, () => {});
  assert.equal(out.answer, "你好");
  assert.equal(out.ended_reason, "completed");
});

test("P2-4 流式尾部 error 帧无换行被拒绝", async () => {
  const chunks = [enc('{"message":{"content":"你好"},"done":true}\n'), enc('{"error":"boom"}')];
  const g = gw(() => streamRes(chunks));
  await assert.rejects(
    g.call("local", [{ role: "user", content: "hi" }], false, undefined, () => {}),
    (e) => e.code === "upstream_error",
  );
});

test("P2-4 长度截止：done_reason=length 返回 ended_reason=length", async () => {
  const chunks = [enc('{"message":{"content":"部分"},"done":true,"done_reason":"length"}\n')];
  const g = gw(() => streamRes(chunks));
  const out = await g.call("local", [{ role: "user", content: "hi" }], false, undefined, () => {});
  assert.equal(out.answer, "部分");
  assert.equal(out.ended_reason, "length");
});

test("P2-6 统一限流：同一上游（base_url）共享额度，local limit=1 串行", async () => {
  const ka = keepAlive();
  try {
    let active = 0, maxActive = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const g = gw(
      () =>
        new Promise(async (resolve, reject) => {
          active++;
          maxActive = Math.max(maxActive, active);
          await gate;
          active--;
          resolve(streamRes([enc('{"message":{"content":"x"},"done":true}\n')]));
        }),
      { localConcurrency: 1 },
    );
    const p1 = g.call("local", [{ role: "user", content: "a" }], false, undefined, () => {});
    await sleep(30);
    const p2 = g.call("local", [{ role: "user", content: "b" }], false, undefined, () => {});
    let p2done = false;
    p2.then(() => (p2done = true));
    await sleep(60);
    assert.equal(p2done, false, "limit=1 时第二个调用应等待");
    assert.equal(maxActive, 1);
    release();
    await Promise.all([p1, p2]);
    assert.equal(p2done, true);
  } finally {
    ka();
  }
});

test("P2-6 统一限流：不同上游（base_url）独立额度，各 limit=1 可并行", async () => {
  const ka = keepAlive();
  try {
    let active = 0, maxActive = 0;
    const g = gw(
      (url) =>
        new Promise((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            active--;
            const isLocal = String(url).includes("/api/chat");
            resolve(
              isLocal
                ? streamRes([enc('{"message":{"content":"x"},"done":true}\n')])
                : streamRes([
                    enc('data: {"choices":[{"delta":{"content":"x"}}]}\n'),
                    enc("data: [DONE]\n"),
                  ]),
            );
          }, 60);
        }),
      { localConcurrency: 1, cloudConcurrency: 1 },
    );
    await Promise.all([
      g.call("local", [{ role: "user", content: "a" }], false, undefined, () => {}),
      g.call("cloud", [{ role: "user", content: "b" }], false, undefined, () => {}),
    ]);
    assert.equal(maxActive, 2);
  } finally {
    ka();
  }
});

test("P1-2 停机等待：stop 等待运行中的生成任务退出", async (t) => {
  const ka = keepAlive();
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    const f = await fixture(t, {
      call: async () => {
        await gate;
        return answer("local");
      },
    });
    const a = await f.add("employee");
    await f.request(
      "/turns",
      { request_id: "req-stop-0000001", question: "问", domain: domains[0] },
      a.cookie,
    );
    const tickP = f.ws.tick("generate");
    await sleep(80);
    let stopped = false;
    const stopP = f.ws.stop().then(() => (stopped = true));
    await sleep(100);
    assert.equal(stopped, false, "stop 应等待运行中的生成任务");
    release();
    await Promise.all([tickP, stopP]);
    assert.equal(stopped, true);
  } finally {
    ka();
  }
});

test("P2-5 原子领取：三个重叠 tick 只领 activeGen=2，第三个留在排队", async (t) => {
  const ka = keepAlive();
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    const f = await fixture(t, {
      call: async () => {
        await gate;
        return answer("local");
      },
    });
    for (let i = 1; i <= 3; i++) {
      const u = await f.add("emp" + i);
      await f.request(
        "/turns",
        { request_id: `req-atomic-${String(i).padStart(7, "0")}`, question: "问", domain: domains[0] },
        u.cookie,
      );
    }
    const ticks = [
      f.ws.tick("generate"),
      f.ws.tick("generate"),
      f.ws.tick("generate"),
    ];
    await sleep(120); // 让三个 tick 完成领取（runGeneration 阻塞在 gate）
    const jobs = await f.repo.list("jobs", {});
    const gens = jobs.filter((j) => j.type === "generate");
    const running = gens.filter((j) => j.status === "running").length;
    const queued = gens.filter((j) => j.status === "queued").length;
    assert.equal(running, 2, "重叠 tick 不应超领，running=" + running);
    assert.equal(queued, 1, "第三个任务应留在排队，queued=" + queued);
    release();
    await Promise.all(ticks);
    await sleep(40);
    await f.ws.stop();
  } finally {
    ka();
  }
});
