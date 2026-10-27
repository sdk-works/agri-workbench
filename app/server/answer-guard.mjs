/**
 * 回答输出防线（纯函数，无副作用，便于单测）。
 *
 * 提示词约束是概率性的：实测带图"先描述图片"约 85% 生效，禁止编造实时读数
 * 也偶有漏网。本模块在输出落库前做确定性兜底，与提示词形成"概率 + 确定"双保险。
 *
 * 三条防线：
 *  1. stripForSpeech  播报清洗：TTS 前剥离 Markdown/符号，避免念出"星号星号"
 *  2. scanRealtime    实时读数检测：模型编造"当前温度 28 度"这类断言
 *  3. scanDosage      高危剂量检测：农药稀释倍数/每亩用量缺安全提示时补一句
 */

/* ── 1. 播报清洗 ─────────────────────────────────────────── */

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 去掉 emoji 与各类装饰符号（保留中文标点与数字单位） */
function stripSymbols(s) {
  return s
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
      "",
    )
    .replace(/[•·▪◦●○◆◇★☆→←↑↓✅❌⚠️]/gu, "");
}

/**
 * 把 Markdown 文本转成适合朗读的口语文本。
 * 不做摘要、不改写语义，只剥离标记，保证"念出来的就是原文意思"。
 */
export function stripForSpeech(input) {
  if (typeof input !== "string" || !input.trim()) return "";
  let s = input;

  // 代码块整体丢弃（读出来毫无意义），行内代码去掉反引号保留内容
  s = s.replace(/```[\s\S]*?```/g, "。");
  s = s.replace(/`([^`]*)`/g, "$1");
  // 图片直接丢，链接只留文字
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 分隔线 / 表格分隔行
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, "");
  s = s.replace(/^\s*\|?[\s:|-]{5,}\|?\s*$/gm, "");
  // 标题符号
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  // 引用符号
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  // 粗体/斜体/删除线
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(^|[\s（(])\*([^*\n]+)\*(?=[\s，。；！？）)]|$)/g, "$1$2");
  s = s.replace(/~~([^~]+)~~/g, "$1");
  // 表格竖线转停顿，避免念出"竖线"
  s = s.replace(/\s*\|\s*/g, "，");
  // 有序列表 1) / 1. / 1、 → "第一，"
  s = s.replace(/^\s*(\d{1,2})\s*[.)、]\s*/gm, (m, d) => {
    const n = Number(d);
    return n >= 1 && n <= 10 ? `第${CN_NUM[n - 1]}，` : "";
  });
  // 无序列表符号
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  // 复选框
  s = s.replace(/^\s*\[[ xX]\]\s*/gm, "");
  // emoji 与装饰符号
  s = stripSymbols(s);
  // 括号里只有符号的空壳
  s = s.replace(/[（(]\s*[)）]/g, "");
  // 压缩空白与连续标点
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/。{2,}/g, "。");
  s = s.replace(/，{2,}/g, "，");
  s = s.replace(/\n{3,}/g, "\n\n");
  // 行首多余空格
  s = s.replace(/^[ \t]+/gm, "");
  return s.trim();
}

/* ── 2. 实时读数检测 ─────────────────────────────────────── */

const QUANTITY =
  "(?:温度|湿度|气温|土温|室温|棚温|光照|照度|光强|二氧化碳|CO2|co2|含水率|含水量|EC值|ec值|pH值|ph值|土壤pH)";
const TIME_WORD = "(?:当前|现在|此刻|目前|今天|实时|眼下|本次|刚测|实时监测)";
const NUMBER_UNIT =
  "[-+]?\\d+(?:\\.\\d+)?\\s*(?:℃|°C|度|%|％|ppm|PPM|lx|lux|勒克斯|mS/cm|ms/cm|μS/cm)";

// 时点 + 环境量 + 可选判断词 + 数值 + 单位，同一句话内相邻才算
const REALTIME_HARD = new RegExp(
  `${TIME_WORD}[^。！？；\\n]{0,14}${QUANTITY}[^。！？；\\n]{0,8}${NUMBER_UNIT}`,
  "g",
);
// 时点 + 天气现象（模型无从得知，出现即低置信编造）
const REALTIME_WEATHER = new RegExp(
  `${TIME_WORD}[^。！？；\\n]{0,6}(?:天气|气温)?[^。！？；\\n]{0,4}(?:晴|阴天|多云|小雨|中雨|大雨|暴雨|雷阵雨|降雪|下雪|刮风|风力\\d)`,
  "g",
);

/**
 * 检测回答中"声称知道当下实测值"的句子。
 * hard 命中＝具体数值断言；soft 命中＝天气现象断言（可能是条件假设，故低置信）。
 */
export function scanRealtime(input) {
  const text = typeof input === "string" ? input : "";
  const hard = [
    ...new Set((text.match(REALTIME_HARD) || []).map((s) => s.trim())),
  ];
  const soft = [
    ...new Set((text.match(REALTIME_WEATHER) || []).map((s) => s.trim())),
  ];
  return { hard, soft, hasHard: hard.length > 0, hasSoft: soft.length > 0 };
}

/* ── 3. 高危剂量检测 ─────────────────────────────────────── */

const DOSE_UNIT = "(?:克|g|G|千克|kg|公斤|毫升|ml|mL|升|L)";
const AREA_UNIT = "(?:亩|公顷|桶|升水|平方米|株)";

// 用量语序有多种，全部覆盖：30克/亩、每亩用30克、30克兑水30斤、稀释1000倍、1000倍液
const DOSAGE_PATTERNS = [
  new RegExp(`\\d+(?:\\.\\d+)?\\s*${DOSE_UNIT}\\s*\\/\\s*${AREA_UNIT}`, "g"),
  new RegExp(
    `每${AREA_UNIT}\\s*(?:地|水)?\\s*(?:用|施|兑|加|喷|撒)?\\s*\\d+(?:\\.\\d+)?\\s*${DOSE_UNIT}`,
    "g",
  ),
  new RegExp(
    `\\d+(?:\\.\\d+)?\\s*(?:克|g|G|毫升|ml|mL)\\s*兑\\s*\\d+(?:\\.\\d+)?\\s*(?:斤|公斤|kg|千克|升|L)\\s*水`,
    "g",
  ),
  /稀释\s*\d+(?:\.\d+)?\s*(?:到|至|-|~)?\s*\d*\s*倍/g,
  /\d+(?:\.\d+)?\s*倍液/g,
];
// 出现这些字样说明已经交代了依据，不必补提示
const DOSAGE_SAFE_HINT =
  /(?:标签|说明书|登记|推荐用量|按推荐|遵照|当地农技|农技人员|安全间隔期)/;

/**
 * 检测是否给出农药/肥料的具体用量。
 * 给了用量但没提"按标签"这类依据时，需要补一句安全提示——错配会造成药害。
 */
export function scanDosage(input) {
  const text = typeof input === "string" ? input : "";
  const hits = [];
  for (const re of DOSAGE_PATTERNS) {
    for (const m of text.matchAll(re)) hits.push(m[0].trim());
  }
  const unique = [...new Set(hits)];
  return {
    hits: unique,
    hasDosage: unique.length > 0,
    // 有用量且已交代依据 → 无需补提示
    needsNotice: unique.length > 0 && !DOSAGE_SAFE_HINT.test(text),
  };
}

/* ── 组合入口 ───────────────────────────────────────────── */

export const REALTIME_NOTICE =
  "\n\n（说明：我这边看不到棚内实时数据，上面若涉及当前数值，请以控制柜或传感器的实际读数为准。）";

export const DOSAGE_NOTICE =
  "\n\n（提示：具体用量请以该产品登记标签为准，不同作物、不同生育期用量差别很大，建议先小面积试喷。）";

/**
 * 对一条已完成回答做统一体检，返回是否需要追加提示以及命中了什么。
 * 只做"追加说明"，不改写模型原文——避免误伤语义。
 */
export function reviewAnswer(input) {
  const text = typeof input === "string" ? input : "";
  const realtime = scanRealtime(text);
  const dosage = scanDosage(text);
  const notices = [];
  if (realtime.hasHard) notices.push(REALTIME_NOTICE);
  if (dosage.needsNotice) notices.push(DOSAGE_NOTICE);
  return {
    realtime,
    dosage,
    notices,
    // 拼接后的最终文本；无命中时原样返回
    text: notices.length ? `${text}${notices.join("")}` : text,
  };
}
