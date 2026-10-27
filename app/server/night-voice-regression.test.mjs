/**
 * 夜间独立回归：411 ai_voice 白天改动（2026-10-27）的四件事
 *   1) 语音与图片关联  2) 路由  3) 取消  4) 重试
 *
 * 这不是对既有 voice-image*.test.mjs / voice-turn.test.mjs 的重跑：
 * 那几个文件只覆盖它们的作者当时想到的路径，而"重试"分支在今天的实现里
 * 一条用例都没有。这里按夜间任务书口径重新写一遍，断言只认当前实现契约。
 *
 * 契约依据（来自 10-27 白天的提交说明）：
 *   - 8ce38df：取消单独记为 canceled 终态，不再混进 failed；
 *              取消的图回到 attached（不算失败，用户可再用它重问）；
 *              轮次新增 image_followup / image_attachment_id / has_image / role。
 *   - 603826c：语音不套短问快通道（useFast 加 && !voice），
 *             语音留在强角色且不覆盖模型名；文字短问仍走 fast。
 *   - 8ce38df：createTurn 支持 retry=true，同一 request_id 复用原轮次重跑，
 *             不新增历史记录。
 *
 * 运行（隔离工作副本，不碰生产）：
 *   /home/jingyang/agri-ai/runtime/node/bin/node --test server/night-voice-regression.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";

const DOMAIN = "种植管理";

const png = (bytes = "png-bytes") => ({
  buffer: Buffer.from(bytes),
  mime: "image/png",
  ext: "png",
});

async function upload(f, user, bytes) {
  return f.ws.saveVoiceImage(user, { ...png(bytes), conversation_id: "" });
}

/* ------------------------------------------------------------------ */
/* 1. 语音与图片关联                                                   */
/* ------------------------------------------------------------------ */

test("关联：view 给出 image_attachment_id，换图指向新附件，文字轮不吃视觉规则", async (t) => {
  const f = await fixture(t);
  const a = await f.add("night-emp-1", "employee", [DOMAIN]);

  const imgA = await upload(f, a.user, "img-A");
  const first = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "这片叶子是什么病害",
    domain: DOMAIN,
    image_id: imgA.image_id,
  });
  await f.ws.tick("generate");

  const view = await f.ws.voiceTurnView(a.user, first.turn_id);
  assert.equal(view.image_attachment_id, imgA.image_id, "view 必须给出本轮实际引用的附件编号");
  assert.equal(view.has_image, true, "本轮带图");
  assert.ok(view.role, "view 必须给出本轮实际使用的角色");

  // 换一张图 → 必须指向新附件，不是沿用上一轮那个
  const imgB = await upload(f, a.user, "img-B");
  const other = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "那这一张呢",
    domain: DOMAIN,
    image_id: imgB.image_id,
  });
  await f.ws.tick("generate");
  const t2 = await f.repo.get("turns", other.turn_id);
  assert.equal(t2.image_attachment.id, imgB.image_id, "换了图必须引用新附件");
  assert.notEqual(t2.image_attachment.id, imgA.image_id, "不能串成上一轮的图");

  // 文字轮不带图 → 视觉字段必须为空，不吃带图的规则
  const text = await f.turn(a.cookie, "今天要不要浇水", {});
  const t3 = await f.repo.get("turns", text.id);
  const v3 = await f.ws.voiceTurnView(a.user, text.id);
  assert.ok(!t3.image_attachment, "文字轮不该挂附件");
  assert.equal(v3.has_image, false, "不带图的轮次 has_image 必须为假");
});

test("关联：同图追问仍引用同一张图，并标记 image_followup", async (t) => {
  const f = await fixture(t);
  const a = await f.add("night-emp-2", "employee", [DOMAIN]);

  const img = await upload(f, a.user, "same-img");
  const first = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "这张图里的是什么",
    domain: DOMAIN,
    image_id: img.image_id,
  });
  await f.ws.tick("generate");

  const follow = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "那需要注意什么",
    domain: DOMAIN,
    image_id: img.image_id,
    conversation_id: (await f.repo.get("turns", first.turn_id)).conversation_id,
  });
  await f.ws.tick("generate");

  const t2 = await f.repo.get("turns", follow.turn_id);
  assert.equal(t2.image_attachment.id, img.image_id, "同图追问必须仍引用同一张图");
  assert.equal(t2.image_followup, true, "同一张图的第二轮要标记为追问");

  const v = await f.ws.voiceTurnView(a.user, follow.turn_id);
  assert.equal(v.image_attachment_id, img.image_id, "追问轮的 view 同样要给出附件编号");
});

/* ------------------------------------------------------------------ */
/* 2. 路由                                                             */
/* ------------------------------------------------------------------ */

test("路由：带图进能看图的角色；语音无图留在强角色且不套快通道；文字短问仍走 fast", async (t) => {
  const f = await fixture(t);
  const a = await f.add("night-emp-3", "employee", [DOMAIN]);

  // 语音 + 图 → 必须落到声明支持看图的能力角色（不许静默退回看不见图的角色）
  const img = await upload(f, a.user, "route-img");
  const vi = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "这叶子怎么了",
    domain: DOMAIN,
    image_id: img.image_id,
  });
  await f.ws.tick("generate");
  const tv = await f.repo.get("turns", vi.turn_id);
  assert.equal(tv.candidates.length, 1, "语音恒单候选");
  assert.ok(
    ["vision", "local"].includes(tv.candidates[0].role),
    `带图必须落到能看图的角色，实际 ${tv.candidates[0].role}`,
  );

  // 语音 无图 → 留在强角色，且不套用短问快通道（603826c 的意图）
  const vs = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "今天要不要浇水",
    domain: DOMAIN,
  });
  await f.ws.tick("generate");
  const tvs = await f.repo.get("turns", vs.turn_id);
  assert.equal(tvs.candidates[0].model_requested, "", "语音不能被快通道覆盖模型名");
  assert.equal(tvs.source, "voice");

  // 文字短问 → 快通道行为不变。注意 candidates 是并发完成的，
  // 顺序不固定（实测同一进程内 4 次里有 2 次 cloud 在前），
  // 因此断言落在 model_plan 与"强角色候选是否被覆盖成快模型"上，不碰 candidates[0]。
  const tf = await f.repo.get("turns", (await f.turn(a.cookie, "在吗", {})).id);
  assert.equal(tf.model_plan.role, "fast", "文字短问仍应走快通道");
  const strong = tf.candidates.find((c) => c.role === "local");
  assert.ok(strong, "应当存在强角色候选");
  assert.equal(
    strong.model_requested,
    "qwen3:30b-a3b-bench",
    "文字短问仍应把强角色候选覆盖成快模型（与语音形成对照，防止把两边改坏）",
  );
});

/* ------------------------------------------------------------------ */
/* 3. 取消                                                             */
/* ------------------------------------------------------------------ */

test("取消：轮次到达 canceled 终态，不卡 generating，附件不算失败", async (t) => {
  const f = await fixture(t);
  const a = await f.add("night-emp-4", "employee", [DOMAIN]);

  const img = await upload(f, a.user, "cancel-img");
  const r = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "湿度高怎么办",
    domain: DOMAIN,
    image_id: img.image_id,
  });

  const before = await f.ws.voiceTurnView(a.user, r.turn_id);
  assert.equal(before.status, "generating", "前置条件：尚未生成");

  const canceled = await f.ws.cancelTurn(a.user, r.turn_id);
  assert.equal(canceled.status, "canceled", "取消后必须是 canceled 终态");

  const after = await f.repo.get("turns", r.turn_id);
  assert.equal(after.status, "canceled", "落盘必须是 canceled 终态");
  assert.equal(after.ended_reason, "canceled", "终态要带结束原因");
  assert.notEqual(after.status, "generating", "不能卡在生成中");
  assert.equal(after.candidates.length, 1, "不留半截候选");
  assert.equal(after.candidates[0].status, "failed");
  assert.equal(after.candidates[0].error_code, "canceled");

  // 取消不是图的失败：图还能拿来重问
  const rec = await f.repo.get("voice_images", img.image_id);
  assert.notEqual(rec.status, "failed", "取消不能把图标记成失败");
  assert.equal(rec.status, "attached", "图应回到可用状态");
});

/* ------------------------------------------------------------------ */
/* 4. 重试（今天新增的分支，既有测试零覆盖）                            */
/* ------------------------------------------------------------------ */

test("重试：同 request_id + retry 复用同一轮次，不新增历史", async (t) => {
  let fails = true;
  const calls = [];
  const generate = async (role, messages, json, images, onToken, opts) => {
    calls.push(role);
    if (fails) throw Object.assign(Error(`${role} 不可用`), { code: "disabled" });
    return {
      answer: `${role} 重试后的答案`,
      model: role + "-model",
      provider: "local",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const f = await fixture(t, { call: generate });
  const a = await f.add("night-emp-5", "employee", [DOMAIN]);
  const requestId = randomUUID();

  const first = await f.request(
    "/turns",
    { request_id: requestId, question: "番茄打顶怎么判断", domain: DOMAIN },
    a.cookie,
  );
  await f.ws.tick("generate");
  const failed = await f.repo.get("turns", first.data.id);
  assert.equal(failed.status, "failed", "前置条件：首轮失败（不对这只用例放松）");

  const before = (await f.request("/turns", undefined, a.cookie)).data.items.length;

  // 不带 retry 的重放 → 幂等回放同一轮次，不重复生成
  fails = false;
  const replay = await f.request(
    "/turns",
    { request_id: requestId, question: "番茄打顶怎么判断", domain: DOMAIN },
    a.cookie,
  );
  assert.equal(replay.data.id, first.data.id, "同 request_id 必须落到同一轮次");
  assert.equal(replay.data.duplicate, true, "幂等回放要给出 duplicate 标记");
  const callsAfterReplay = calls.length;
  await f.ws.tick("generate");
  assert.equal(calls.length, callsAfterReplay, "幂等回放不得再发起一次生成");

  // 带 retry → 复用同一轮次重跑，历史里不新增记录
  const retryRes = await f.request(
    "/turns",
    {
      request_id: requestId,
      question: "番茄打顶怎么判断",
      domain: DOMAIN,
      retry: true,
    },
    a.cookie,
  );
  assert.equal(retryRes.data.id, first.data.id, "重试必须复用原轮次，不能新建");
  assert.equal(retryRes.data.duplicate, true, "重试命中原轮次要标记 duplicate");

  const after = (await f.request("/turns", undefined, a.cookie)).data.items.length;
  assert.equal(after, before, "重试不得让历史多出一条记录");

  await f.ws.tick("generate");
  const retried = await f.repo.get("turns", first.data.id);
  assert.equal(retried.status, "completed", "重试后该轮次应完成");
  assert.match(String(retried.candidates[0].text), /重试后的答案/);
});
