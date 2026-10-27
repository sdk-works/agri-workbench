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
  // 2026-10-27 提示词改版把这条写成了可执行的"结论先行 + 三段式依据"，
  // 之前断言的"必须保留 2 到 3 句关键依据"这句措辞从未落地，断言因此长期是红的。
  assert.match(
    prompt,
    /结论先行/,
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

test("带图轮必须带看图规则，文字轮不得带", async (t) => {
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
  // 2026-10-27 口径反转：原来要求"先描述图片"，实测把用户的问题挤掉（问"怎么做"时
  // 只顾描述图甚至被截断），现在明确"图是依据，问题才是要答的"，并要求别复述画面。
  assert.match(
    p,
    /图是依据，问题才是要答的/,
    "带图轮必须把图定位成依据，而不是要描述的对象",
  );
  assert.match(
    p,
    /不要脱离这张图去讲通用清单/,
    "必须明确禁止脱离图片去罗列通用清单（VL 实测会被这条带走）",
  );
  assert.match(
    p,
    /不要每轮都把图片从头描述一遍/,
    "必须明确禁止每轮重复描述同一张图（用户原话：不管我发什么都会回复这是…）",
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

// ── 语音落盘前的确定性清洗 ──
// 背景（2026-10-27 用户实测）：追问"苗子长得均匀吗"，模型从"第一"一路数到"第一百"，
// 1622 字全是"没有…失衡"的排除项，TTS 要念十几分钟。提示词压不住，所以落盘前按点截断。
// 这里的断言只锁行为（点数、长度），不锁实现细节。
function cnNum(n) {
  const d = "零一二三四五六七八九";
  if (n <= 10) return n === 10 ? "十" : d[n];
  if (n < 20) return "十" + d[n - 10];
  if (n < 100) return d[Math.floor(n / 10)] + "十" + (n % 10 ? d[n % 10] : "");
  return "一百";
}

test("语音兜底：模型数到第一百时按三点截断，不把穷举念给用户", async (t) => {
  const parts = [];
  for (let i = 1; i <= 100; i++) parts.push(`第${cnNum(i)}、没有出现第${i}类问题。`);
  const runaway = parts.join("");
  const f = await fixture(t, {
    call: async (role) => ({
      answer: runaway,
      model: role + "-model",
      provider: "local",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const a = await f.add("speak-trim");
  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-trim-${randomUUID().slice(0, 8)}`,
    question: "苗子长得均匀吗？",
    domain: "种植管理",
  });
  await f.ws.tick("generate");
  const turn = await f.repo.get("turns", created.turn_id);
  const text = String(turn.candidates[0].text || "");
  const points = [...text.matchAll(/第[一二三四五六七八九十百]+[、，,：:．.]/g)].length;
  assert.ok(points > 0 && points <= 3, `播报内容最多三点，实际 ${points} 点`);
  assert.ok(text.length <= 300, `播报内容不能超长，实际 ${text.length} 字`);
  assert.doesNotMatch(text, /第一百/, "不许把穷举念到第一百");
});

test("语音口径：不把用户的问题念一遍再回答", async (t) => {
  const q = "这个阶段需要补光吗？";
  const f = await fixture(t, {
    call: async (role) => ({
      answer: "这个阶段需要补光吗？这个阶段不需要补光，靠自然光就够。",
      model: role + "-model",
      provider: "local",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const a = await f.add("speak-echo");
  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-echo-${randomUUID().slice(0, 8)}`,
    question: q,
    domain: "种植管理",
  });
  await f.ws.tick("generate");
  const turn = await f.repo.get("turns", created.turn_id);
  const text = String(turn.candidates[0].text || "");
  assert.equal(text, "这个阶段不需要补光，靠自然光就够。", "问题原文要从答案开头剥掉");
});

test("同图追问：不再以「这是一块…」复述开场", async (t) => {
  // 用户原话："不管我发什么都会回复这是…"。模型会把它改写成"这是一块/这是一台"绕过
  // tail 的禁用清单，所以落盘前按"同图追问 + 首句是纯描述"剥掉。
  let round = 0;
  const f = await fixture(t, {
    call: async (role) => {
      round++;
      return {
        answer:
          round === 1
            ? "这是一块工业控制模块，上面有 CAN 和 RS232 接口。"
            : "这是一块工业控制模块，上面有 CAN 和 RS232 接口。需要注意先确认端子定义再接线。",
        model: role + "-model",
        provider: "local",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  });
  const a = await f.add("img-followup");
  const up = await f.ws.saveVoiceImage(a.user, {
    ...png(),
    conversation_id: "",
    dedup_key: "img-followup-1",
  });
  const first = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-fu-1-${randomUUID().slice(0, 8)}`,
    question: "这张图里是什么？",
    domain: "种植管理",
    image_id: up.image_id,
  });
  await f.ws.tick("generate");
  const t1 = await f.repo.get("turns", first.turn_id);
  // 首问允许描述：这轮用户就是在问"是什么"
  assert.match(String(t1.candidates[0].text), /^这是一块/, "首问该描述就描述");

  const second = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-fu-2-${randomUUID().slice(0, 8)}`,
    question: "那需要注意什么？",
    domain: "种植管理",
    image_id: up.image_id,
    conversation_id: t1.conversation_id,
  });
  await f.ws.tick("generate");
  const t2 = await f.repo.get("turns", second.turn_id);
  const text = String(t2.candidates[0].text || "");
  assert.equal(t2.image_followup, true, "同一张图的第二轮要标记成追问");
  assert.doesNotMatch(text, /^这是一块/, "追问不该再用描述图片开头");
  assert.match(text, /端子定义/, "复述被剥掉后，真正的回答必须还在");
});
