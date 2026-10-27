// 视觉路由行为测试：带图请求绝不能落到看不见图的角色上。
// 这里验证的是「决策结果」，不是某个配置字段 —— 配置写对了但路由仍可能出错，
// 所以断言落在 route() 的返回值上。
import test from "node:test";
import assert from "node:assert/strict";
import { createPolicy } from "./policy.mjs";

// 造一个假能力表：sees 集合 = 能看图的角色
function caps({ enabled = [], sees = [] } = {}) {
  return {
    enabled: (r) => enabled.includes(r),
    seesImage: (r) => sees.includes(r),
    modelFor: (r) => `model-${r}`,
  };
}

const plain = createPolicy(null);

test("带图：默认视觉角色可用时走它", () => {
  const d = plain.route({
    hasImage: true,
    question: "叶子发黄",
    caps: caps({ enabled: ["vision", "local"], sees: ["vision", "local"] }),
  });
  assert.equal(d.imageRole, "vision");
  assert.equal(d.imageUnavailable, false);
  assert.deepEqual(d.roles, ["vision"]);
});

test("带图：默认视觉角色禁用时，落到池中另一个能看图的角色，不落纯文本", () => {
  const d = plain.route({
    hasImage: true,
    question: "叶子发黄",
    caps: caps({ enabled: ["local"], sees: ["local"] }), // vision 关掉了
  });
  assert.equal(d.imageRole, "local");
  assert.equal(d.imageUnavailable, false);
});

test("带图：没有任何角色能看图时，标记不可用且不给纯文本角色", () => {
  const d = plain.route({
    hasImage: true,
    question: "叶子发黄",
    caps: caps({ enabled: ["local", "fast", "vision"], sees: [] }), // 都能开，但都看不见图
  });
  assert.equal(d.imageUnavailable, true);
  assert.equal(d.imageRole, "");
  assert.deepEqual(d.roles, [], "有图但无视觉能力时不能给出任何候选角色");
});

test("带图：深度问题 + 强角色能看图时升级到它", () => {
  const d = plain.route({
    hasImage: true,
    question: "这片叶子背面有白粉，最近湿度很大，帮我看看到底是什么病，怎么防治",
    caps: caps({ enabled: ["vision", "local"], sees: ["vision", "local"] }),
  });
  assert.equal(d.deep, true);
  assert.equal(d.imageRole, "local");
});

test("带图：深度问题但强角色看不见图时，仍留在默认视觉角色", () => {
  const d = plain.route({
    hasImage: true,
    question: "这片叶子背面有白粉，最近湿度很大，帮我看看到底是什么病，怎么防治",
    caps: caps({ enabled: ["vision", "local"], sees: ["vision"] }), // local 是纯文本
  });
  assert.equal(d.imageRole, "vision");
  assert.equal(d.imageUnavailable, false);
});

test("无图：不触发视觉不可用，也不跑视觉角色", () => {
  const d = plain.route({
    hasImage: false,
    question: "什么时候浇水",
    caps: caps({ enabled: ["fast", "local", "cloud"], sees: ["vision"] }),
  });
  assert.equal(d.imageUnavailable, false);
  assert.notEqual(d.imageRole, "vision");
});

test("有图路径不会被判定为纯文本 fast 通道", () => {
  const d = plain.route({
    hasImage: true,
    question: "看图",
    caps: caps({ enabled: ["vision", "local", "fast"], sees: ["vision"] }),
  });
  assert.equal(d.useFast, false, "带图不能用 fast 纯文本通道");
  assert.equal(d.tier, "strong");
});
