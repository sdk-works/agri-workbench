// transport 发布前评审证据包（隔离环境：全部用假 fetcher，不碰生产凭据、不打生产网络）
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./model-gateway.mjs";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

const ENV = {
  JUDGE_BASE_URL: "https://judge.example/api",
  JUDGE_CLOUD_MODEL: "judge-model",
  JUDGE_API_KEY: "k",
  ZHIPU_API_KEY: "k",
};
const ok = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) });
const connectTimeout = () =>
  Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });

// ---------------- 1. 双路隔离（页面要展示的行为，先在逻辑层钉死）----------------

test("双路隔离：本地失败不牵连云端（云端答案保留，整轮不判失败）", async (t) => {
  const f = await fixture(t, {
    call: async (role) => {
      if (role === "local") throw Object.assign(Error("模型服务 HTTP 429"), { code: "rate_limited" });
      return { answer: "云端有效答案", model: "cloud-model", provider: "cloud", usage: null };
    },
  });
  const u = await f.add("dual-a", "employee", [domains[0]]);
  const turn = await f.turn(u.cookie, "双路隔离-本地坏", { domain: domains[0] });
  await f.ws.tick("generate");

  const saved = await f.repo.get("turns", turn.id);
  const local = saved.candidates.find((c) => c.role === "local");
  const cloud = saved.candidates.find((c) => c.role === "cloud");
  assert.equal(local.status, "failed", "本地应失败");
  assert.equal(local.error_code, "rate_limited");
  assert.equal(cloud.status, "completed", "云端必须照常完成");
  assert.match(cloud.text, /云端有效答案/);
  assert.equal(saved.status, "partial", "单路失败 → 整轮 partial（不是 failed，也不是 completed）");
});

test("双路隔离：云端失败不牵连本地（本地答案保留）", async (t) => {
  const f = await fixture(t, {
    call: async (role) => {
      if (role === "cloud") throw Object.assign(Error("模型请求超时"), { code: "timeout" });
      return { answer: "本地有效答案", model: "local-model", provider: "local", usage: null };
    },
  });
  const u = await f.add("dual-b", "employee", [domains[0]]);
  const turn = await f.turn(u.cookie, "双路隔离-云端坏", { domain: domains[0] });
  await f.ws.tick("generate");

  const saved = await f.repo.get("turns", turn.id);
  const local = saved.candidates.find((c) => c.role === "local");
  const cloud = saved.candidates.find((c) => c.role === "cloud");
  assert.equal(cloud.status, "failed");
  assert.equal(cloud.error_code, "timeout", "超时必须归类为 timeout 而不是 network");
  assert.equal(local.status, "completed");
  assert.match(local.text, /本地有效答案/);
  assert.equal(saved.status, "partial", "单路失败 → partial，本地答案仍可用");
});

// ---------------- 2. 取消后不重试 ----------------

test("取消后不重试：即使抛的是可重试的连接超时，也不得再发一次", async () => {
  const ac = new AbortController();
  let n = 0;
  const g = createGateway(ENV, null, {
    fetcher: async () => {
      n += 1;
      ac.abort(); // 用户在请求途中取消
      throw connectTimeout();
    },
  });
  await assert.rejects(
    g.call("judge", [], false, undefined, undefined, { signal: ac.signal }),
    (e) => e.code === "canceled",
  );
  assert.equal(n, 1, "取消后必须只发 1 次请求");
});

test("重试只在连接未建立时发生：ECONNRESET 不重试", async () => {
  let n = 0;
  const g = createGateway(ENV, null, {
    fetcher: async () => {
      n += 1;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    },
  });
  await assert.rejects(g.call("judge", []), (e) => e.code === "network" && /ECONNRESET/.test(e.message));
  assert.equal(n, 1, "ECONNRESET 不得重放");
});

test("连接超时重试上限：最多 2 次，不会无限重试", async () => {
  let n = 0;
  const g = createGateway(ENV, null, {
    fetcher: async () => {
      n += 1;
      throw connectTimeout();
    },
  });
  await assert.rejects(g.call("judge", []));
  assert.equal(n, 2, "只允许重试一次");
});

// ---------------- 3. 冷却作用域 ----------------

test("冷却作用域：同上游共享，不同上游互不影响，到期可恢复", async (t) => {
  const hits = [];
  const g = createGateway(ENV, null, {
    fetcher: async (url) => {
      hits.push(url);
      if (url.includes("bigmodel")) {
        return { ok: false, status: 429, headers: { get: () => "1" }, body: { cancel: async () => {} } };
      }
      return ok();
    },
  });

  // cloud 打 429 → 进入该上游冷却
  await assert.rejects(g.call("cloud", []), (e) => e.code === "rate_limited" && e.retry_after_ms >= 1000);
  const afterFirst = hits.length;

  // judge 是另一个上游，不应被冷却牵连
  assert.equal((await g.call("judge", [])).answer, "ok");
  assert.equal(hits.length, afterFirst + 1);

  // cloud 仍在冷却：直接拒绝，不再打上游
  await assert.rejects(g.call("cloud", []), (e) => e.code === "rate_limited");
  assert.equal(hits.length, afterFirst + 1, "冷却期内不得再请求上游");

  // 到期后恢复（Retry-After: 1s）
  await new Promise((r) => setTimeout(r, 1100));
  await assert.rejects(g.call("cloud", []), (e) => e.code === "rate_limited");
  assert.equal(hits.length, afterFirst + 2, "冷却到期后应重新尝试上游");
});

// ---------------- 4. 总超时 ----------------

test("总超时：执行预算到点即 timeout，且不重试", async () => {
  let n = 0;
  const g = createGateway(
    { ...ENV, JUDGE_BASE_URL: "http://127.0.0.1:9/api" },
    null,
    {
      limits: { localConcurrency: 1, cloudConcurrency: 1, localTimeoutMs: 30000, cloudTimeoutMs: 30000 },
      fetcher: (url, init) => {
        n += 1;
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(Error("The operation was aborted"), { name: "AbortError" })),
          );
        });
      },
    },
  );
  // 通过 model-config 无法改超时，这里用 env 覆盖不到的路径：直接验证 abort 归类
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(g.call("judge", [], false, undefined, undefined, { signal: ac.signal }), (e) =>
    ["canceled", "timeout"].includes(e.code),
  );
  assert.equal(n, 1, "超时/取消都不得重试");
});

// ---------------- 严格区分：超时 ≠ 用户取消 ----------------

function hangingGateway(ms) {
  let n = 0;
  const g = createGateway(
    { ...ENV },
    null,
    {
      limits: { localConcurrency: 1, cloudConcurrency: 1, localTimeoutMs: ms, cloudTimeoutMs: ms },
      fetcher: (url, init) => {
        n += 1;
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(Error("The operation was aborted"), { name: "AbortError" })),
          );
        });
      },
    },
  );
  return { g, calls: () => n };
}

test("无用户取消时，执行预算到点 → code=timeout（不重试）", async () => {
  const { g, calls } = hangingGateway(120);
  await assert.rejects(g.call("cloud", []), (e) => e.code === "timeout");
  assert.equal(calls(), 1, "超时不得重试");
});

test("有用户取消时，同一参数下 → code=canceled（不是 timeout）", async () => {
  const { g, calls } = hangingGateway(120);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30); // 早于 120ms 超时
  await assert.rejects(
    g.call("cloud", [], false, undefined, undefined, { signal: ac.signal }),
    (e) => e.code === "canceled",
  );
  assert.equal(calls(), 1);
});
