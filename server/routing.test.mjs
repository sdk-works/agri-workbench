import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("路由：普通文字走 30B，深度思考与图片走 27B", async (t) => {
  const f = await fixture(t);
  const a = await f.add("route-a", "employee", [domains[0]]);

  // 普通文字
  const normal = await f.turn(a.cookie, "普通问题", { domain: domains[0] });
  let saved = await f.repo.get("turns", normal.id);
  assert.equal(saved.model_tier, "fast");
  assert.equal(
    saved.candidates.find((c) => c.role === "local").model_requested,
    "qwen3:30b-a3b-bench",
  );
  assert.equal(
    saved.candidates.find((c) => c.role === "cloud").model_requested,
    "",
    "云端不能被覆盖成本地模型",
  );
  const fastCall = f.calls.filter((c) => c.role === "local").pop();
  assert.equal(fastCall.opts.think, false, "普通模式关闭思考");
  assert.equal(fastCall.opts.reasoning_effort, "minimal");

  // 深度思考
  const deep = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "深度问题",
      domain: domains[0],
      deep: true,
    },
    a.cookie,
  );
  assert.equal(deep.status, 202, JSON.stringify(deep.data));
  await f.ws.tick("generate");
  saved = await f.repo.get("turns", deep.data.id);
  assert.equal(saved.model_tier, "strong");
  assert.equal(saved.deep, true);
  assert.equal(saved.candidates.find((c) => c.role === "local").model_requested, "");
  const strongCall = f.calls.filter((c) => c.role === "local").pop();
  assert.equal(strongCall.opts.think, true, "深度模式开启思考");
  assert.equal(strongCall.opts.reasoning_effort, "medium");

  // 带图片
  const img = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "这张图里叶片怎么了",
      domain: domains[0],
      image: { mime: "image/png", data: PNG },
    },
    a.cookie,
  );
  assert.equal(img.status, 202, JSON.stringify(img.data));
  await f.ws.tick("generate");
  saved = await f.repo.get("turns", img.data.id);
  assert.equal(saved.model_tier, "strong");
  assert.equal(saved.candidates.find((c) => c.role === "local").model_requested, "");
});
