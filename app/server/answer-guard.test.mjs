import test from "node:test";
import assert from "node:assert/strict";
import {
  stripForSpeech,
  scanRealtime,
  scanDosage,
  reviewAnswer,
  REALTIME_NOTICE,
  DOSAGE_NOTICE,
} from "./answer-guard.mjs";

/* ── 播报清洗 ── */

test("播报清洗：剥离 markdown 标记但不丢内容", () => {
  const md = [
    "**结论**：土表过湿。",
    "",
    "判断依据",
    "- 通体乳白、半透明",
    "- 身体细长、分节",
    "",
    "1) 控水和通气",
    "2) 减少食物源",
  ].join("\n");
  const out = stripForSpeech(md);
  assert.ok(!out.includes("**"), "残留粗体标记");
  assert.ok(!/^\s*[-*]\s/m.test(out), "残留列表符号");
  assert.ok(!/\d\)/.test(out), "残留编号符号");
  assert.ok(out.includes("土表过湿"), "丢失结论内容");
  assert.ok(out.includes("通体乳白"), "丢失列表内容");
  assert.ok(out.includes("第一"), "有序列表未转口语序号");
});

test("播报清洗：表格与链接转成可朗读文本", () => {
  const md =
    "| 病害 | 症状 |\n|---|---|\n| 白粉病 | 叶面白粉 |\n\n详见[植保手册](http://x.com/a)";
  const out = stripForSpeech(md);
  assert.ok(!out.includes("|"), "残留表格竖线");
  assert.ok(!out.includes("http"), "残留 URL");
  assert.ok(out.includes("白粉病"), "丢失表格内容");
  assert.ok(out.includes("植保手册"), "丢失链接文字");
});

test("播报清洗：空输入安全返回", () => {
  assert.equal(stripForSpeech(""), "");
  assert.equal(stripForSpeech(null), "");
  assert.equal(stripForSpeech(undefined), "");
});

test("播报清洗：emoji 不进入播报", () => {
  const out = stripForSpeech("注意通风 ✅ 湿度别太高 ⚠️");
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(out), "残留 emoji");
  assert.ok(out.includes("注意通风"));
});

/* ── 实时读数检测 ── */

test("实时检测：命中编造的环境读数", () => {
  for (const s of [
    "当前棚内温度是 28 度，建议通风。",
    "现在湿度已经达到 85%，偏高。",
    "今天气温 32℃，要注意遮阳。",
    "目前 CO2 浓度 800ppm。",
  ]) {
    assert.ok(scanRealtime(s).hasHard, `应命中但漏了：${s}`);
  }
});

test("实时检测：不误伤通用农艺规律", () => {
  for (const s of [
    "白天 25 到 28 度最适宜，夜间不低于 15 度。",
    "湿度超过 85% 时灰霉病风险上升。",
    "温度过高时要及时通风降温。",
    "缓苗期空气湿度保持在 70% 左右。",
  ]) {
    assert.ok(!scanRealtime(s).hasHard, `误伤了通用知识：${s}`);
  }
});

test("实时检测：天气断言走低置信通道", () => {
  const r = scanRealtime("今天天气晴朗，棚内升温会很快。");
  assert.ok(r.hasSoft, "天气断言应被标记");
});

/* ── 剂量检测 ── */

test("剂量检测：命中每亩用量与稀释倍数", () => {
  assert.ok(scanDosage("每亩用 30 克兑水喷雾。").hasDosage);
  assert.ok(scanDosage("稀释 1000 倍液喷雾。").hasDosage);
});

test("剂量检测：已交代登记标签则不补提示", () => {
  const r = scanDosage("按登记标签推荐用量，每亩 30 克兑水。");
  assert.ok(r.hasDosage);
  assert.equal(r.needsNotice, false);
});

test("剂量检测：无用量不触发", () => {
  assert.equal(
    scanDosage("先看叶背有没有虫，再决定是否用药。").needsNotice,
    false,
  );
});

/* ── 组合 ── */

test("组合：命中追加说明，未命中原样返回", () => {
  const clean = "先看叶背，再判断是否用药。";
  assert.equal(reviewAnswer(clean).text, clean);

  const dirty = "当前棚内温度是 28 度。每亩用 30 克喷雾。";
  const r = reviewAnswer(dirty);
  assert.ok(r.text.includes(REALTIME_NOTICE));
  assert.ok(r.text.includes(DOSAGE_NOTICE));
  assert.ok(r.text.startsWith(dirty), "不应改写原文");
});
