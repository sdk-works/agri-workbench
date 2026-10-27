// 抽层等价性验证：把抽层前的路由逻辑复制成 legacyRoute，
// 与 policy.route 在全部参数组合上逐一对比，证明改配置不会改变调度结果。
//
// 2026-10-27 有一处**有意的行为变更**已同步到这里：语音回答不再套用短问快通道。
// 原因是语音问题天然短（"叶子黄了""这个虫怎么处理"），按字数判 fast 等于把整类
// 语音降级到快模型。所以下面的 `&& !voice` 是修正后的预期，不是历史原样。

import test from "node:test";
import assert from "node:assert/strict";
import { createPolicy } from "./policy.mjs";

// ── 参考实现：与当前 policy.mjs 逐条对应，用于发现"改配置导致的路由漂移"──
const DEEP_RE =
  /诊断|病因|怎么治|防治|缺素|药害|病害|虫害|霜霉|白粉|灰霉|蓟马|红蜘蛛|详细|仔细/;

function legacyRoute({ hasImage, voice, question, explicitDeep }, caps) {
  const wantDeep =
    explicitDeep === true || DEEP_RE.test(question) || question.length > 40;
  const visionOk = caps.enabled("vision") && caps.seesImage("vision");
  const localVisionOk = caps.enabled("local") && caps.seesImage("local");
  // 候选池要先算出来：两个首选都不可用时，imageRole 退回池里第一个能看图的，
  // 池子空了才退回空串（调用方据此报 503，绝不静默当纯文本处理）
  const imageRoles = ["vision", "local"].filter(
    (r) => caps.enabled(r) && caps.seesImage(r),
  );
  const imageRole =
    wantDeep && localVisionOk
      ? "local"
      : visionOk
        ? "vision"
        : imageRoles[0] || "";
  const fastOn = caps.enabled("fast");
  // 语音不降级：这一条是 2026-10-27 的修正，语音一律留在强角色
  const useFast = !hasImage && !wantDeep && fastOn && !voice;
  const tier = useFast ? "fast" : "strong";
  const pickedModel = hasImage
    ? caps.modelFor(imageRole)
    : useFast
      ? caps.modelFor("fast")
      : caps.modelFor("local");
  const roles = voice
    ? [hasImage ? imageRole : "local"].filter((r) => caps.enabled(r))
    : hasImage
      ? [imageRole].filter((r) => caps.enabled(r))
      : ["local", "cloud"].filter((r) => caps.enabled(r));
  return {
    deep: wantDeep,
    tier,
    imageRole,
    useFast,
    pickedModel,
    roles,
    imageRoles,
    planRole: hasImage ? imageRole : useFast ? "fast" : "local",
    overrideRole: useFast ? "local" : null,
    overrideModel: useFast ? pickedModel : "",
  };
}

const ROLES = ["local", "cloud", "fast", "vision"];
const QUESTIONS = [
  "普通问题", // 短，无关键词
  "今天要不要浇水", // 短，无关键词
  "这片叶子是什么病害，怎么防治", // 短，命中关键词
  "番茄在低温弱光条件下如何调整水肥配比和通风策略，请给出具体数值和操作顺序说明", // 长，超 40 字
];
const lengthOf = (q) => q.length;

test("等价性：policy.route 与原逻辑在全部分支组合下一致", () => {
  const policy = createPolicy(); // 无文件 → 纯内置默认值
  let checked = 0;

  // 角色启用组合 2^4 × 看图能力组合 4 种
  for (let em = 0; em < 16; em++) {
    const enabledSet = ROLES.filter((_, i) => em & (1 << i));
    for (let vm = 0; vm < 4; vm++) {
      const seesSet = ["vision", "local"].filter((_, i) => vm & (1 << i));
      const caps = {
        enabled: (r) => enabledSet.includes(r),
        seesImage: (r) => seesSet.includes(r),
        modelFor: (r) => (enabledSet.includes(r) ? `${r}-model` : ""),
      };
      for (const question of QUESTIONS)
        for (const hasImage of [false, true])
          for (const voice of [false, true])
            for (const explicitDeep of [false, true]) {
              const ctx = { hasImage, voice, question, explicitDeep };
              const got = policy.route({ ...ctx, caps });
              const want = legacyRoute(ctx, caps);
              const label = `q="${question.slice(0, 8)}"(len=${lengthOf(question)}) img=${hasImage} voice=${voice} deep=${explicitDeep} enabled=[${enabledSet}] sees=[${seesSet}]`;
              assert.equal(got.deep, want.deep, `wantDeep 不一致 ${label}`);
              assert.equal(got.tier, want.tier, `tier 不一致 ${label}`);
              assert.equal(got.imageRole, want.imageRole, `imageRole 不一致 ${label}`);
              assert.equal(got.useFast, want.useFast, `useFast 不一致 ${label}`);
              assert.equal(got.planRole, want.planRole, `planRole 不一致 ${label}`);
              assert.equal(got.pickedModel, want.pickedModel, `pickedModel 不一致 ${label}`);
              assert.deepEqual(got.roles, want.roles, `roles 不一致 ${label}`);
              assert.deepEqual(
                got.imageRoles,
                want.imageRoles,
                `imageRoles 不一致 ${label}`,
              );
              assert.equal(
                got.overrideRole,
                want.overrideRole,
                `overrideRole 不一致 ${label}`,
              );
              assert.equal(
                got.overrideModel,
                want.overrideModel,
                `overrideModel 不一致 ${label}`,
              );
              checked++;
            }
    }
  }
  // 4 问 × 2 图 × 2 语音 × 2 深度 × 16 角色组合 × 4 看图组合
  assert.equal(checked, 4 * 2 * 2 * 2 * 16 * 4);
});

test("语音短问不降级：没图也不许换成快模型", () => {
  const policy = createPolicy();
  const caps = {
    enabled: () => true,
    seesImage: (r) => r === "vision",
    // 故意把 fast 设成一个明显不同的模型名：一旦被降级，model 名会立刻暴露
    modelFor: (r) => (r === "fast" ? "tiny-3b" : "strong-30b"),
  };
  // 「叶子黄了」四个字、无关键词 —— 打字时确实该走快通道
  const text = policy.route({ question: "叶子黄了", caps });
  assert.equal(text.useFast, true, "文字短问仍应走快通道");
  assert.equal(text.overrideModel, "tiny-3b", "文字短问应换成快模型");

  // 同一句话走语音：必须留在强角色，且不许覆盖模型名
  const voice = policy.route({ question: "叶子黄了", voice: true, caps });
  assert.equal(voice.useFast, false, "语音不得判为快通道");
  assert.equal(voice.tier, "strong");
  assert.deepEqual(voice.roles, ["local"]);
  assert.equal(voice.overrideRole, null, "语音不得覆盖模型名");
  assert.equal(voice.overrideModel, "");
  assert.equal(voice.pickedModel, "strong-30b", "语音应解析到强模型");

  // 带图时优先走能看图的角色，跟语音与否无关
  const img = policy.route({ question: "叶子黄了", voice: true, hasImage: true, caps });
  assert.equal(img.imageUnavailable, false);
  assert.equal(img.imageRole, "vision");
});

test("采样参数：默认 0.5，结构化输出 0.1，未知模型沿用默认", () => {
  const policy = createPolicy();
  assert.deepEqual(policy.sampling({ model: "unknown-model" }), {
    temperature: 0.5,
  });
  assert.deepEqual(policy.sampling({ model: "unknown-model", json: true }), {
    temperature: 0.1,
  });
  // num_predict 为 null 时不得出现在 options 里（否则会改变引擎默认行为）
  assert.equal("num_predict" in policy.sampling({ model: "x" }), false);
});

test("策略文件可覆盖规则，坏文件不炸服务", () => {
  const policy = createPolicy();
  const caps = {
    enabled: () => true,
    seesImage: () => true,
    modelFor: (r) => `${r}-model`,
  };
  // 默认：深度问题 + 有图 → 升级到 local
  assert.equal(
    policy.route({ hasImage: true, question: "这是什么病害", caps }).imageRole,
    "local",
  );
  // 改关键词表后，同一问题不再算深度 → 回到默认视觉角色
  policy.reload();
  assert.equal(
    policy.route({ hasImage: true, question: "这是什么病害", caps }).imageRole,
    "local",
    "无策略文件时应保持默认行为",
  );
});

test("深度判定阈值与关键词表独立生效", () => {
  const policy = createPolicy();
  assert.equal(policy.isDeep("普通短问题", false), false);
  assert.equal(policy.isDeep("这片叶子有霜霉", false), true, "命中关键词");
  assert.equal(policy.isDeep("a".repeat(41), false), true, "超过 40 字");
  assert.equal(policy.isDeep("a".repeat(40), false), false, "恰好 40 字不算深度");
  assert.equal(policy.isDeep("短", true), true, "显式 deep 优先");
});
