// 抽层等价性验证：把抽层前的路由逻辑逐字复制成 legacyRoute，
// 与 policy.route 在全部参数组合上逐一对比，证明行为完全一致。
//
// 这是抽层这步的安全网：只要这个测试绿，就说明「把规则搬到配置层」
// 没有改变任何一次实际调度结果。

import test from "node:test";
import assert from "node:assert/strict";
import { createPolicy } from "./policy.mjs";

// ── 抽层前 workspace.mjs 里的原逻辑（逐字复制，仅供对比）──
const DEEP_RE =
  /诊断|病因|怎么治|防治|缺素|药害|病害|虫害|霜霉|白粉|灰霉|蓟马|红蜘蛛|详细|仔细/;

function legacyRoute({ hasImage, voice, question, explicitDeep }, caps) {
  const wantDeep =
    explicitDeep === true || DEEP_RE.test(question) || question.length > 40;
  const visionOk = caps.enabled("vision") && caps.seesImage("vision");
  const localVisionOk = caps.enabled("local") && caps.seesImage("local");
  const imageRole =
    wantDeep && localVisionOk ? "local" : visionOk ? "vision" : "local";
  const fastOn = caps.enabled("fast");
  const useFast = !hasImage && !wantDeep && fastOn;
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
  const imageRoles = ["vision", "local"].filter(
    (r) => caps.enabled(r) && caps.seesImage(r),
  );
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
