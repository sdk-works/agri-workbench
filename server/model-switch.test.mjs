import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "./model-gateway.mjs";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

test("禁用的模型角色：拒绝调用且不发起任何出站请求", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-switch-"));
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      local: {
        adapter: "ollama",
        base_url: "http://127.0.0.1:11434",
        model: "local-model",
      },
      cloud: {
        enabled: false,
        adapter: "compatible",
        base_url: "https://api.example.com/v1",
        model: "cloud-model",
        api_key: "test-key",
      },
    }),
  );
  let outbound = 0;
  const gw = createGateway(
    {},
    file,
    {
      fetcher: async () => {
        outbound++;
        throw new Error("不应发起请求");
      },
    },
  );
  assert.equal(gw.roleEnabled("cloud"), false);
  assert.equal(gw.roleEnabled("local"), true);
  await assert.rejects(
    () => gw.call("cloud", [{ role: "user", content: "hi" }]),
    (e) => e.code === "disabled",
  );
  assert.equal(outbound, 0, "禁用角色不能产生出站请求");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("关闭云端与裁判：只生成本地候选，不产生裁判调用", async (t) => {
  const f = await fixture(t, { disabled: ["cloud", "judge"] });
  const a = await f.add("emp-only-local", "employee", [domains[0]]);
  const turn = await f.turn(a.cookie, "只走本地模型", { domain: domains[0] });

  const stored = await f.repo.get("turns", turn.id);
  assert.equal(stored.candidates.length, 1, "云端禁用后不应再建候选");
  assert.equal(stored.candidates[0].role, "local");
  assert.equal(stored.status, "completed", "单候选完成即为 completed");
  assert.equal(stored.judge.status, "unavailable");

  await f.ws.tick("judge");
  const roles = f.calls.map((c) => c.role);
  assert.ok(!roles.includes("cloud"), "不应调用云端");
  assert.ok(!roles.includes("judge"), "不应调用裁判");
});

test("排队任务在执行前复查开关", async (t) => {
  const f = await fixture(t);
  const a = await f.add("emp-queued", "employee", [domains[0]]);
  // 先按双模型建轮次，但不执行
  const res = await f.request(
    "/turns",
    {
      request_id: "11111111-2222-3333-4444-555555555555",
      question: "排队后关闭云端",
      domain: domains[0],
    },
    a.cookie,
  );
  assert.equal(res.status, 202, JSON.stringify(res.data));
  assert.equal((await f.repo.get("turns", res.data.id)).candidates.length, 2);

  // 执行前关闭云端
  f.disabled.push("cloud");
  await f.ws.tick("generate");
  await f.ws.tick("generate");

  const stored = await f.repo.get("turns", res.data.id);
  const cloud = stored.candidates.find((c) => c.role === "cloud");
  assert.equal(cloud.status, "failed");
  assert.equal(cloud.error_code, "disabled");
  assert.ok(
    !f.calls.some((c) => c.role === "cloud"),
    "关闭后不能再发起云端请求",
  );
});
