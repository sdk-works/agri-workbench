// 模型策略层：把「选哪个模型」和「用什么采样参数」从业务代码里抽出来。
//
// 职责边界：
//   - 本文件只做决策，不发请求、不碰数据库、不读用户数据
//   - 决策依据全部来自 model-policy.json（关键词、长度阈值、角色映射、采样参数）
//   - 内置 DEFAULTS 与 2026-10-27 抽层前的硬编码值逐字一致，保证零行为变更
//
// 调用方只需注入能力查询函数（caps），不需要知道网关如何实现。

import fs from "node:fs";

// 抽层前的原始正则，逐字搬运，顺序不能改（顺序影响匹配日志可读性）
const DEFAULT_DEEP_KEYWORDS = [
  "诊断", "病因", "怎么治", "防治", "缺素", "药害", "病害",
  "虫害", "霜霉", "白粉", "灰霉", "蓟马", "红蜘蛛", "详细", "仔细",
];

const DEFAULTS = {
  version: 1,
  signals: {
    // 命中任一关键词即视为深度问题（原 DEEP_RE）
    deep_keywords: DEFAULT_DEEP_KEYWORDS,
    // 超过该字符数视为深度问题（原 question.length > 40）
    deep_min_length: 40,
  },
  sampling: {
    // 本地引擎默认采样参数（原 model-gateway.mjs: temperature: 0.5）
    // null 表示"不传该字段"，沿用引擎自身默认值
    default: { temperature: 0.5, num_predict: null },
    // 结构化输出覆盖（原 temperature: 0.1）
    json: { temperature: 0.1 },
    // 按模型覆盖，优先级高于 default，低于 json
    by_model: {},
  },
  routes: {
    // 角色名映射：改这里就能把某类问答换到另一个角色，不动代码
    image_default: "vision", // 有图 · 常规
    image_deep: "local", // 有图 · 深度/长诊断
    text_fast: "fast", // 无图 · 短问/语音
    text_strong: "local", // 无图 · 深度/长问
    cloud_fallback: "cloud", // 文字问题的第二候选
    // 带图时依次尝试的角色（决定 503 判定与候选池）
    image_pool: ["vision", "local"],
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// 深合并：数组整体替换（关键词表需要可增可删，不能逐项合并）
function merge(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      isPlainObject(base?.[key]) && isPlainObject(value)
        ? merge(base[key], value)
        : value;
  }
  return out;
}

function compileKeywords(list) {
  const words = (Array.isArray(list) ? list : [])
    .filter((w) => typeof w === "string" && w.trim())
    .map((w) => w.trim());
  if (!words.length) return /$^/; // 永不匹配，而不是匹配一切
  return new RegExp(
    words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  );
}

export function createPolicy(filename) {
  let config = structuredClone(DEFAULTS);
  let deepRe = compileKeywords(config.signals.deep_keywords);

  function reload() {
    if (!filename) return config;
    try {
      if (!fs.existsSync(filename)) return config;
      const raw = JSON.parse(fs.readFileSync(filename, "utf8"));
      config = merge(structuredClone(DEFAULTS), raw);
      deepRe = compileKeywords(config.signals.deep_keywords);
      console.log(
        `[policy] 已加载 ${filename}：路由=${JSON.stringify(config.routes)}`,
      );
    } catch (e) {
      // 策略文件写坏了不能让服务起不来：保留上一版，把问题喊出来
      console.error(`[policy] 策略文件读取失败，沿用上一版：${e.message}`);
    }
    return config;
  }
  reload();

  // 深度判定：显式 deep 标记 > 关键词 > 长度
  // 与原实现完全一致，三个条件同为「或」关系
  function isDeep(question, explicitDeep) {
    if (explicitDeep === true) return true;
    const text = String(question ?? "");
    if (deepRe.test(text)) return true;
    return text.length > Number(config.signals.deep_min_length ?? 40);
  }

  // 路由决策。caps 由调用方注入，保持本函数纯粹、可单测。
  function route({
    hasImage = false,
    voice = false,
    question = "",
    explicitDeep = false,
    caps,
  }) {
    const r = config.routes;
    const enabled = (role) => Boolean(caps?.enabled?.(role));
    const seesImage = (role) => Boolean(caps?.seesImage?.(role));
    const modelFor = (role) => String(caps?.modelFor?.(role) ?? "");

    const deep = isDeep(question, explicitDeep);

    // 带图必须进「声明支持看图」的角色，一个都没有就不许静默退成纯文本
    const imagePool = Array.isArray(r.image_pool) ? r.image_pool : ["vision", "local"];
    const imageRoles = imagePool.filter((role) => enabled(role) && seesImage(role));

    const imageDefaultOk = enabled(r.image_default) && seesImage(r.image_default);
    const imageDeepOk = enabled(r.image_deep) && seesImage(r.image_deep);
    // 默认走轻量视觉模型；只有深度问题 + 强模型真能看图时才升级。
    // 两个首选都不可用时，退回候选池里第一个「真能看图」的角色；
    // 绝不退回纯文本角色 —— 那会把图片送进看不见它的模型，上游直接 500。
    const imageRole = deep && imageDeepOk
      ? r.image_deep
      : imageDefaultOk
        ? r.image_default
        : imageRoles[0] || "";
    // 有图但池子里一个能看图的都没有：调用方据此明确报错，不允许静默降级
    const imageUnavailable = hasImage && imageRoles.length === 0;

    const fastOn = enabled(r.text_fast);
    const useFast = !hasImage && !deep && fastOn;
    const tier = useFast ? "fast" : "strong";
    const planRole = hasImage ? imageRole : useFast ? r.text_fast : r.text_strong;
    const pickedModel = modelFor(planRole);

    // 语音单路播报只给一个候选；带图也只有一个（两个视觉模型同时上显存会互挤）
    const roles = (
      voice
        ? [hasImage ? imageRole : r.text_strong]
        : hasImage
          ? [imageRole]
          : [r.text_strong, r.cloud_fallback]
    ).filter(enabled);

    return {
      deep,
      tier,
      imageRole,
      imageRoles,
      imageUnavailable,
      useFast,
      planRole,
      pickedModel,
      roles,
      // 需要覆盖模型名的候选角色：fast 走 strong 通道时把 local 换成快模型
      // 原实现只覆盖 local，不覆盖 cloud，这里保持一致
      overrideRole: useFast ? r.text_strong : null,
      overrideModel: useFast ? pickedModel : "",
    };
  }

  // 采样参数：default < by_model < json
  // 返回 null/undefined 的键会被删掉，即「不传给引擎」
  function sampling({ model = "", json = false } = {}) {
    const s = config.sampling || {};
    let out = { ...(s.default || {}) };
    const byModel = model && isPlainObject(s.by_model) ? s.by_model[model] : null;
    if (isPlainObject(byModel)) out = { ...out, ...byModel };
    if (json && isPlainObject(s.json)) out = { ...out, ...s.json };
    return Object.fromEntries(
      Object.entries(out).filter(([, v]) => v !== null && v !== undefined),
    );
  }

  return {
    reload,
    isDeep,
    route,
    sampling,
    // 当前生效配置，供排障与留痕使用
    snapshot: () => structuredClone(config),
  };
}

// 默认实例：没有策略文件（例如测试环境）时使用内置默认值，行为与抽层前一致
export const defaultPolicy = createPolicy();

// 便捷入口：按环境变量或指定路径加载
export function policyFromEnv(env, fallbackPath) {
  const file = env?.MODEL_POLICY_PATH || fallbackPath;
  return file ? createPolicy(file) : defaultPolicy;
}
