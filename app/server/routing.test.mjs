import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

// 契约（2026-10-26 调整）：
//   有图 · 常规        → vision(7B)
//   有图 · 深度/诊断问 → local(27B，自带 mmproj)
//   无图 · 短问/语音   → fast(30B-A3B)，靠 model_requested 覆盖
//   无图 · 深度/长问   → local(27B)
//   语音恒为单候选（单路播报）
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IMG = { mime: "image/png", data: PNG };

test("调度：短问走 fast，深度走 27B，带图走 vision(7B)", async (t) => {
  const f = await fixture(t);
  const a = await f.add("route-a", "employee", [domains[0]]);

  // 1) 普通文字 → fast(30B-A3B)
  let saved = await f.repo.get("turns", (await f.turn(a.cookie, "普通问题")).id);
  assert.equal(saved.model_tier, "fast");
  assert.equal(saved.model_plan.role, "fast");
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

  // 2) 显式深度 → strong(27B)，开思考
  saved = await f.repo.get(
    "turns",
    (await f.turn(a.cookie, "深度问题", { deep: true })).id,
  );
  assert.equal(saved.model_tier, "strong");
  assert.equal(saved.deep, true);
  assert.equal(saved.candidates.find((c) => c.role === "local").model_requested, "");
  assert.equal(f.calls.filter((c) => c.role === "local").pop().opts.think, true);

  // 3) 带图短问 → 只有 vision 一个候选，且不开思考
  saved = await f.repo.get("turns", (await f.turn(a.cookie, "这是什么", { image: IMG })).id);
  assert.equal(saved.model_tier, "strong");
  assert.deepEqual(saved.candidates.map((c) => c.role), ["vision"]);
  assert.equal(saved.deep, false, "视觉模型不带推理开关");
  assert.equal(saved.model_plan.has_image, true);
  assert.equal(saved.model_plan.role, "vision");

  // 4) 带图 + 诊断类问题 → 升级 27B（local），仍不开思考
  saved = await f.repo.get(
    "turns",
    (await f.turn(a.cookie, "这片叶子是什么病害，怎么防治", { image: IMG })).id,
  );
  assert.deepEqual(saved.candidates.map((c) => c.role), ["local"]);
  assert.equal(saved.model_plan.role, "local");
  assert.equal(saved.deep, false);
});

test("调度：语音恒单候选，无图走 fast，带图走 vision", async (t) => {
  const f = await fixture(t);
  const a = await f.add("route-b", "employee", [domains[0]]);

  // 语音短问 → 单候选 local + fast 模型
  let saved = await f.repo.get(
    "turns",
    (await f.turn(a.cookie, "今天要不要浇水", { voice: true })).id,
  );
  assert.equal(saved.source, "voice");
  assert.equal(saved.candidates.length, 1);
  assert.deepEqual(saved.candidates.map((c) => c.role), ["local"]);
  // 2026-10-27 603826c 起语音不套短问快通道（useFast 加 && !voice）：
  // 语音一律留在强角色，且不再把 local 的模型名覆盖成 fast 的模型名。
  // 断言必须落在"没被覆盖"上——写成"等于某个快模型名"等于给整类语音降级放行。
  assert.equal(saved.candidates[0].model_requested, "");
  assert.equal(saved.model_plan.role, "local");

  // 语音带图 → 单候选 vision
  saved = await f.repo.get(
    "turns",
    (await f.turn(a.cookie, "这叶子怎么了", { voice: true, image: IMG })).id,
  );
  assert.equal(saved.candidates.length, 1);
  assert.deepEqual(saved.candidates.map((c) => c.role), ["vision"]);
});

test("会话：POST /conversations 先建空会话，语音轮挂到该会话", async (t) => {
  const f = await fixture(t);
  const a = await f.add("route-c", "employee", [domains[0]]);

  const made = await f.request("/conversations", { title: "语音会话" }, a.cookie);
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.ok(made.data.id, "返回新会话 id");
  assert.equal(made.data.title, "语音会话");
  assert.equal(made.data.owner, a.user.id);

  const list = await f.request("/conversations", undefined, a.cookie);
  assert.ok(
    list.data.items.some((c) => c.id === made.data.id),
    "空会话要出现在会话列表里",
  );

  const turn = await f.turn(a.cookie, "会话里的第一问", {
    voice: true,
    conversation_id: made.data.id,
  });
  const saved = await f.repo.get("turns", turn.id);
  assert.equal(saved.conversation_id, made.data.id);
  assert.equal(saved.sequence, 1, "空会话的第一个轮次序号从 1 开始");
});
