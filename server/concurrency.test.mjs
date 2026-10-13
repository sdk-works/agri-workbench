import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const answer = (role, extra = {}) => ({
  answer: role + " 答案",
  model: role + "-model",
  provider: role === "local" ? "local" : "cloud",
  usage: { input_tokens: 5, output_tokens: 5 },
  ...extra,
});

test("并发领取：两个不同员工的任务同时执行，候选并行（模型调用重叠）", async (t) => {
  const active = { n: 0, max: 0, byRole: { local: 0, cloud: 0 } };
  const f = await fixture(t, {
    call: async (role) => {
      active.n++;
      active.max = Math.max(active.max, active.n);
      active.byRole[role] = Math.max(active.byRole[role], active.n);
      await sleep(70);
      active.n--;
      return answer(role);
    },
  });
  const a = await f.add("employee-a"),
    b = await f.add("employee-b");
  await f.request(
    "/turns",
    { request_id: "req-a-000000001", question: "问A", domain: domains[0] },
    a.cookie,
  );
  await f.request(
    "/turns",
    { request_id: "req-b-000000002", question: "问B", domain: domains[0] },
    b.cookie,
  );
  await Promise.all([f.ws.tick("generate"), f.ws.tick("generate")]);
  const ta = await f.repo.get("turns", "req-a-000000001"),
    tb = await f.repo.get("turns", "req-b-000000002");
  assert.equal(ta.status, "completed");
  assert.equal(tb.status, "completed");
  assert.equal(ta.candidates.filter((c) => c.status === "completed").length, 2);
  assert.equal(tb.candidates.filter((c) => c.status === "completed").length, 2);
  assert.ok(active.max >= 2, "两个任务应并行，实际并发=" + active.max);
  // 两个任务串行执行时 byRole 无法都到 2（本地+云端同槽位）
  assert.equal(active.max, 4, "本地2+云端2=4 路候选应重叠，实际=" + active.max);
});

test("候选并行：单个任务的 A/B 两路同时发起", async (t) => {
  const inflight = [];
  const f = await fixture(t, {
    call: async (role) => {
      inflight.push(role);
      await sleep(60);
      return answer(role);
    },
  });
  const a = await f.add("employee");
  await f.request(
    "/turns",
    { request_id: "req-cand-0000001", question: "问", domain: domains[0] },
    a.cookie,
  );
  await f.ws.tick("generate");
  const turn = await f.repo.get("turns", "req-cand-0000001");
  assert.equal(turn.status, "completed");
  assert.equal(turn.candidates.filter((c) => c.status === "completed").length, 2);
  assert.ok(
    inflight.includes("local") && inflight.includes("cloud"),
    "两路都应发起",
  );
});

test("一路失败另一条继续完成（partial），错误码正确", async (t) => {
  const f = await fixture(t, {
    call: async (role) => {
      await sleep(40);
      if (role === "cloud")
        throw Object.assign(Error("模型服务 HTTP 500"), {
          code: "upstream_error",
        });
      return answer(role);
    },
  });
  const a = await f.add("employee");
  await f.request(
    "/turns",
    { request_id: "req-fail-0000001", question: "问", domain: domains[0] },
    a.cookie,
  );
  await f.ws.tick("generate");
  const turn = await f.repo.get("turns", "req-fail-0000001");
  assert.equal(turn.status, "partial");
  const localC = turn.candidates.find((c) => c.role === "local"),
    cloudC = turn.candidates.find((c) => c.role === "cloud");
  assert.equal(localC.status, "completed");
  assert.equal(cloudC.status, "failed");
  assert.equal(cloudC.error_code, "upstream_error");
});

test("采用 A 并停止运行中的 B（adopt）", async (t) => {
  let releaseB;
  const gateB = new Promise((r) => (releaseB = r));
  const f = await fixture(t, {
    call: async (role, m, j, img, onToken, opts) => {
      if (role === "local") {
        await sleep(40);
        return answer(role);
      }
      await gateB; // B 阻塞，等待被取消
      throw Object.assign(Error("已取消"), { code: "canceled" });
    },
  });
  try {
    const a = await f.add("employee");
    await f.request(
      "/turns",
      { request_id: "req-adopt-0000001", question: "问", domain: domains[0] },
      a.cookie,
    );
    const gen = f.ws.tick("generate");
    // 有界等待：任一路完成即继续，避免固定 sleep 在全套负载下时序不稳定
    let before;
    for (let i = 0; i < 60; i++) {
      before = await f.repo.get("turns", "req-adopt-0000001");
      if (before.candidates.some((c) => c.status === "completed")) break;
      await sleep(50);
    }
    const doneC = before.candidates.find((c) => c.status === "completed");
    assert.ok(doneC, "应有一条已完成");
    const otherC = before.candidates.find((c) => c.label !== doneC.label);
    const res = await f.request(
      "/turns/req-adopt-0000001/adopt",
      { choice: doneC.label },
      a.cookie,
    );
    assert.equal(res.status, 200, JSON.stringify(res.data));
    releaseB(); // 让 B 的阻塞释放（应已被 abort 标 stopped）
    await gen;
    const turn = await f.repo.get("turns", "req-adopt-0000001");
    const adopted = turn.candidates.find((c) => c.label === doneC.label),
      stoppedC = turn.candidates.find((c) => c.label === otherC.label);
    assert.equal(adopted.status, "completed");
    assert.equal(stoppedC.status, "stopped");
    assert.equal(turn.status, "partial");
    // 采用只记录 adopted（决定下轮上下文），不写成正式 A/B 偏好
    assert.equal(turn.adopted?.choice, doneC.label);
    assert.equal(turn.feedback, null);
    const j = await f.repo.get("jobs", "generate-req-adopt-0000001");
    assert.equal(j.status, "completed");
  } finally {
    releaseB(); // 保证 gate 释放，失败时也不会让清理等待 90 秒
  }
});

test("取消运行中的任务（cancel running）", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = await fixture(t, {
    call: async (role) => {
      if (role === "local") return answer(role);
      await gate;
      throw Object.assign(Error("已取消"), { code: "canceled" });
    },
  });
  const a = await f.add("employee");
  await f.request(
    "/turns",
    { request_id: "req-cancel-0000001", question: "问", domain: domains[0] },
    a.cookie,
  );
  try {
    const gen = f.ws.tick("generate");
    await sleep(100);
    const res = await f.request(
      "/turns/req-cancel-0000001/cancel",
      undefined,
      a.cookie,
      "POST",
    );
    assert.equal(res.status, 200);
    release(); // 成功路径先释放 gate，让 cloud 调用退出
    await gen;
    const turn = await f.repo.get("turns", "req-cancel-0000001");
    const cloudC = turn.candidates.find((c) => c.role === "cloud");
    assert.ok(
      ["failed", "stopped"].includes(cloudC.status),
      "云端候选应被取消，实际=" + cloudC.status,
    );
    assert.equal(cloudC.error_code, "canceled");
    const j = await f.repo.get("jobs", "generate-req-cancel-0000001");
    assert.equal(j.status, "canceled");
  } finally {
    release(); // 失败兜底，避免清理等待 90 秒
  }
});

test("单用户活跃上限：同一员工第二问排队，不同员工才并行", async (t) => {
  const f = await fixture(t, {
    call: async (role) => {
      await sleep(90);
      return answer(role);
    },
  });
  const a = await f.add("employee-a");
  await f.request(
    "/turns",
    { request_id: "req-one-000000001", question: "问1", domain: domains[0] },
    a.cookie,
  );
  const g1 = f.ws.tick("generate");
  await sleep(20); // A 正在跑，activeOwners 含 a
  await f.request(
    "/turns",
    { request_id: "req-one-000000002", question: "问2", domain: domains[0] },
    a.cookie,
  );
  const tick2 = f.ws.tick("generate"); // 同 owner a，不应领取
  await sleep(30);
  // tick2 不应领取（activeOwners 有 a），job 应仍是 queued
  const j2 = await f.repo.get("jobs", "generate-req-one-000000002");
  assert.equal(j2.status, "queued");
  await g1;
  await tick2;
  await f.ws.tick("generate");
  const j2b = await f.repo.get("jobs", "generate-req-one-000000002");
  assert.equal(j2b.status, "completed");
});

test("超时错误标记为 timeout", async (t) => {
  const f = await fixture(t, {
    call: async (role) => {
      if (role === "cloud")
        throw Object.assign(Error("模型请求超时"), { code: "timeout" });
      return answer(role);
    },
  });
  const a = await f.add("employee");
  await f.request(
    "/turns",
    { request_id: "req-time-00000001", question: "问", domain: domains[0] },
    a.cookie,
  );
  await f.ws.tick("generate");
  const turn = await f.repo.get("turns", "req-time-00000001");
  const cloudC = turn.candidates.find((c) => c.role === "cloud");
  assert.equal(cloudC.status, "failed");
  assert.equal(cloudC.error_code, "timeout");
});
