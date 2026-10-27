/**
 * 语音/图片链路补充测试（2026-10-26 夜间，独立工作副本内运行）
 *
 * 与既有 voice-image.test.mjs / voice-turn.test.mjs 的分工：
 * 既有文件已覆盖"上传落盘、跨用户读不到、无视觉模型 503、同图追问、取消语义"等，
 * 本文件只补既有实现里**确实缺失**的四件事，不重复已通过的断言：
 *   1. 播报口径：简洁但不得省略必要步骤与依据（"回答太简单"的修复点）
 *   2. 附件生命周期：ready → attached(analyzing) → analyzed / failed（失败保留原因）
 *   3. 切会话串图：A 会话上传的图不能被 B 会话的轮次引用
 *   4. 重复提交去重：同一幂等键重试不重复落盘（缩略图不是上传成功）
 *
 * 全部使用假上游（test-helpers 的 gateway）与临时 sqlite，不连生产库、不发起真实调用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";

const png = () => ({
  buffer: Buffer.from("fake-png-bytes-for-test"),
  mime: "image/png",
  ext: "png",
});

test("播报口径：复杂问题必须保留关键步骤与判断依据", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("tone-a");
  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-tone-${randomUUID().slice(0, 8)}`,
    question: "番茄叶子发黄边缘干枯，怎么治？",
    domain: "种植管理",
  });
  const raw = await f.repo.get("turns", created.turn_id);
  const prompt = String(raw.system_prompt || "");
  assert.match(prompt, /语音播报要求/, "语音轮必须带播报口径");
  // 这条断言守的是"复杂问题不能只求短、必须带步骤与依据"，不锁具体措辞。
  // 2026-10-27 提示词改版把"关键步骤与判断依据"写成了更可执行的"结论先行 + 必保 2~3 句关键依据（先看什么/据此判断什么/下一步做什么）"，
  // 语义等价且更具体，因此断言对齐新文本；同时要求"简洁不等于省略"必须仍在，防止退回只求短。
  assert.match(
    prompt,
    /必须保留\s*2\s*到\s*3\s*句关键依据/,
    "复杂问题必须保留步骤与依据：提示词不能只要求「尽量短」",
  );
  assert.match(
    prompt,
    /先看什么、据此判断什么、下一步做什么/,
    "步骤与依据必须具体到可执行的三段式",
  );
  assert.match(prompt, /简洁不等于省略/, "必须显式禁止用短换掉依据");
  assert.match(prompt, /不用\s*Markdown/, "播报文本不得出现 Markdown");
  // 2026-10-27：旧提示词那句"系统会在下方自动生成配图…请说明已在下方为你生成配图"实测导致
  // 文字轮 92% 的回答被配图话术劫持（正文被挤掉），已删除。这里锁死不得回潮。
  assert.doesNotMatch(
    prompt,
    /已在下方为你生成配图|描述你设想的画面/,
    "禁止出现鼓励模型提及配图的引导语（会造成配图话术劫持）",
  );
  assert.equal(raw.source, "voice", "来源应标记为 voice");
  assert.equal(raw.model_plan.has_image, false, "无图轮不该走视觉模型");
});

test("附件生命周期：ready → attached → analyzed（成功）", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("life-a");
  const up = await f.ws.saveVoiceImage(a.user, {
    ...png(),
    conversation_id: "",
    dedup_key: "life-shot-1",
  });
  const before = await f.ws.voiceImageOrphans(a.user);
  assert.ok(
    before.some((x) => x.image_id === up.image_id),
    "刚上传未被引用时应出现在孤儿清单（可审计，不静默堆积）",
  );
  assert.equal(
    before.find((x) => x.image_id === up.image_id).status,
    "ready",
    "未引用状态应为 ready",
  );

  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-life-${randomUUID().slice(0, 8)}`,
    question: "看看这片叶子是什么问题",
    domain: "种植管理",
    image_id: up.image_id,
  });
  const raw = await f.repo.get("turns", created.turn_id);
  assert.equal(
    raw.image_attachment && raw.image_attachment.id,
    up.image_id,
    "轮次应记录引用了哪张图",
  );
  const attaching = await f.ws.loadVoiceImage(a.user, up.image_id);
  assert.equal(attaching.rec.status, "attached", "已引用但还没分析完 → attached");
  assert.equal(attaching.rec.stage, "analyzing");

  await f.ws.tick("generate");
  const done = await f.ws.voiceTurnView(a.user, created.turn_id);
  assert.equal(done.status, "completed", "假上游正常时应完成");
  const rec = await f.repo.get("voice_images", up.image_id);
  assert.equal(rec.status, "analyzed", "看过图才算 analyzed");
  assert.equal(rec.stage, "analyzed");
  assert.equal(rec.error, "", "成功时不应留下错误文案");
  const after = await f.ws.voiceImageOrphans(a.user);
  assert.ok(
    !after.some((x) => x.image_id === up.image_id),
    "被引用过的图不应再算孤儿",
  );
});

test("附件生命周期：视觉失败 → failed 且保留原因，不假装看过图", async (t) => {
  const f = await fixture(t, {
    call: async () => {
      throw Object.assign(Error("image input is not supported"), {
        code: "upstream",
      });
    },
  });
  const a = await f.add("life-b");
  const up = await f.ws.saveVoiceImage(a.user, { ...png(), dedup_key: "fail-1" });
  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-fail-${randomUUID().slice(0, 8)}`,
    question: "看看这片叶子是什么问题",
    domain: "种植管理",
    image_id: up.image_id,
  });
  await f.ws.tick("generate");
  const v = await f.ws.voiceTurnView(a.user, created.turn_id);
  assert.equal(v.status, "failed", "上游失败时轮次应为 failed");
  assert.match(v.error || "", /image input is not supported/, "失败原因必须可见");
  const rec = await f.repo.get("voice_images", up.image_id);
  assert.equal(rec.status, "failed", "附件必须跟着标 failed，不能停在 analyzing");
  assert.match(rec.error || "", /image input is not supported/, "附件也应保留原因");
});

test("切会话串图：A 会话的图不能被 B 会话引用", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("conv-a");
  const t1 = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-c1-${randomUUID().slice(0, 8)}`,
    question: "第一轮，不带图",
    domain: "种植管理",
  });
  const convA = t1.conversation_id;
  await f.ws.tick("generate");

  const t2 = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-c2-${randomUUID().slice(0, 8)}`,
    question: "另开一个会话",
    domain: "种植管理",
  });
  const convB = t2.conversation_id;
  await f.ws.tick("generate");
  assert.notEqual(convA, convB, "两次不带 conversation_id 应得到两个会话");

  const up = await f.ws.saveVoiceImage(a.user, {
    ...png(),
    conversation_id: convA,
  });
  let err = null;
  try {
    await f.ws.createTurn(a.user, {
      request_id: `req-c3-${randomUUID().slice(0, 8)}`,
      question: "看看这个",
      domain: "种植管理",
      conversation_id: convB,
      image_id: up.image_id,
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "跨会话引用图片必须被拒绝，不能静默把图带走");
  assert.equal(err.status, 409, "拒绝码应为 409（冲突）");
});

test("重复提交去重：同一幂等键不重复落盘，不同键各自独立", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("dedup-a");
  const first = await f.ws.saveVoiceImage(a.user, {
    ...png(),
    dedup_key: "same-shot",
  });
  const second = await f.ws.saveVoiceImage(a.user, {
    ...png(),
    dedup_key: "same-shot",
  });
  assert.equal(second.image_id, first.image_id, "同一幂等键重试应复用同一张图");
  assert.equal(second.duplicate, true, "复用应显式标记 duplicate");
  const other = await f.ws.saveVoiceImage(a.user, {
    ...png(),
    dedup_key: "other-shot",
  });
  assert.notEqual(other.image_id, first.image_id, "不同幂等键应是不同图片");
  const list = await f.ws.voiceImageOrphans(a.user);
  assert.equal(
    list.filter((x) => x.dedup_key === "same-shot").length,
    1,
    "去重后不应在磁盘/记录里留下第二份",
  );
});

test("跨用户：别人的图看不到，且幂等键按用户隔离", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("iso-a");
  const b = await f.add("iso-b");
  const up = await f.ws.saveVoiceImage(a.user, { ...png(), dedup_key: "mine" });
  await assert.rejects(
    () => f.ws.loadVoiceImage(b.user, up.image_id),
    /不存在或无权访问/,
    "跨用户不得读取别人的图片",
  );
  const mine = await f.ws.voiceImageOrphans(a.user);
  const theirs = await f.ws.voiceImageOrphans(b.user);
  assert.ok(mine.some((x) => x.image_id === up.image_id));
  assert.ok(!theirs.some((x) => x.image_id === up.image_id), "清单也要按用户隔离");
  const bUp = await f.ws.saveVoiceImage(b.user, { ...png(), dedup_key: "mine" });
  assert.notEqual(
    bUp.image_id,
    up.image_id,
    "同名幂等键在不同用户之间不应互相复用",
  );
});

test("带图轮必须先描述图片，文字轮不得带这条规则", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("img-rule");
  const up = await f.ws.saveVoiceImage(a.user, {
    ...png(),
    conversation_id: "",
    dedup_key: "img-rule-1",
  });
  const out = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "看看这个有什么问题",
      domain: "种植管理",
      image_id: up.image_id,
    },
    a.cookie,
  );
  assert.equal(out.status, 202, JSON.stringify(out.data));
  await f.ws.tick("generate");

  const imgTurn = await f.repo.get("turns", out.data.id);
  const p = String(imgTurn.system_prompt || "");
  assert.match(p, /带图提问时/, "带图轮必须带看图优先规则");
  assert.match(
    p,
    /禁止用“通用规律”“常见原因”“第一层”开头/,
    "必须明确禁止在描述图片前罗列通用清单（VL 实测会被这条带走）",
  );
  // 位置要求在基础规则之后：实测放前面会被分层规则覆盖，等于没写
  assert.ok(
    p.indexOf("带图提问时") > p.indexOf("信息不足先问"),
    "带图规则必须排在基础规则之后才管用",
  );

  const textTurn = await f.turn(a.cookie, "番茄叶子发黄怎么办");
  const t2 = await f.repo.get("turns", textTurn.id);
  assert.doesNotMatch(
    String(t2.system_prompt || ""),
    /带图提问时/,
    "纯文字轮不该带看图规则，避免影响分层回答",
  );
});
