import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";
import {
  domains,
  spokenBudgetFor,
  spokenRunaway,
  tidyVoiceFailure,
} from "./workspace.mjs";

const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
function zh(n) {
  if (n < 10) return CN[n];
  if (n < 20) return "十" + (n % 10 ? CN[n % 10] : "");
  if (n < 100)
    return CN[Math.floor(n / 10)] + "十" + (n % 10 ? CN[n % 10] : "");
  const h = CN[Math.floor(n / 100)] + "百";
  const r = n % 100;
  if (!r) return h;
  if (r < 10) return h + "零" + CN[r];
  if (r < 20) return h + "一十" + (r % 10 ? CN[r % 10] : "");
  return h + zh(r);
}
const POINT_RE = /第[一二三四五六七八九十百零]+[、，,：:．.]/g;
function points(text) {
  return (String(text || "").match(POINT_RE) || []).length;
}
function enumerated(n) {
  return Array.from(
    { length: n },
    (_, i) => `第${zh(i + 1)}，再检查第 ${i + 1} 个接线端子有没有松动。`,
  );
}

test("跑飞判定：133 条列举截到 3 点，正常短答一个字不改", () => {
  const budget = spokenBudgetFor("你看我这几张图，说说怎么做");
  assert.equal(budget.tier, "brief");

  const long = enumerated(133).join("\n");
  assert.ok(long.length > 2000, "样例要够长，接近线上那次 4318 字");
  const hit = spokenRunaway(long, budget);
  assert.ok(hit, "133 条必须判为跑飞");
  assert.equal(hit.kind, "points");
  assert.equal(points(hit.text), 3, "只保留前三点");
  assert.ok(hit.text.length < 200, "截断后应是一段能念完的话");

  const ok = "先断电再接线。第二步量一下线圈电阻，确认通断。";
  assert.equal(spokenRunaway(ok, budget), null, "正常短答不得误伤");

  // 只有列表标记、没有"第N"的跑飞靠字数兜底
  const plain = "没有虫。没有病。".repeat(60);
  const byLen = spokenRunaway(plain, budget);
  assert.ok(byLen, "超长文本要按字数判跑飞");
  assert.equal(byLen.kind, "length");

  // 三档：极简 / 简洁 / 详述
  assert.equal(spokenBudgetFor("好了好了，你说的太多了").tier, "tiny");
  assert.equal(spokenBudgetFor("这个你详细讲讲，一步一步来").tier, "detail");
});

test("语音轮列举跑飞：上游被提前中止，落库只剩 3 点", async (t) => {
  let streamed = 0;
  const lines = enumerated(142);
  const f = await fixture(t, {
    call: async (role, messages, json, images, onToken, opts) => {
      for (const line of lines) {
        if (opts?.signal?.aborted)
          throw Object.assign(Error("模型调用已取消"), { code: "canceled" });
        streamed += 1;
        onToken(line + "\n");
        await new Promise((r) => setImmediate(r));
      }
      return {
        answer: lines.join("\n"),
        model: "local-model",
        provider: "local",
      };
    },
  });
  const u = await f.add("emp-runaway");
  const created = await f.ws.createVoiceTurn(u.user, {
    request_id: randomUUID(),
    question: "你看我这几张图，说说怎么做",
    domain: domains[0],
  });
  await f.ws.tick("generate");

  const stored = await f.repo.get("turns", created.turn_id);
  const c = stored.candidates[0];
  assert.equal(c.status, "completed", "跑飞要按截断完成落库，不是失败");
  assert.equal(c.ended_reason, "trimmed");
  assert.equal(c.trimmed.kind, "points");
  assert.ok(points(c.text) <= 3, `最多 3 点，实际 ${points(c.text)}`);
  assert.ok(c.text.length < 260, `截断后应短，实际 ${c.text.length} 字`);
  assert.ok(
    streamed < lines.length,
    `上游必须提前中止，实际发了 ${streamed}/${lines.length} 条`,
  );
  assert.ok(streamed <= 12, `不能跑到几十条才停，实际 ${streamed}`);
});

test("正常语音短答不受影响：不改写、不截断", async (t) => {
  const f = await fixture(t, {
    call: async (role, messages, json, images, onToken) => {
      const text = "先断电再接线。第二步量一下线圈电阻。";
      onToken(text);
      return { answer: text, model: "local-model", provider: "local" };
    },
  });
  const u = await f.add("emp-short");
  const created = await f.ws.createVoiceTurn(u.user, {
    request_id: randomUUID(),
    question: "这个怎么接",
    domain: domains[0],
  });
  await f.ws.tick("generate");
  const c = (await f.repo.get("turns", created.turn_id)).candidates[0];
  assert.equal(c.status, "completed");
  assert.equal(c.ended_reason, "completed");
  assert.equal(c.text, "先断电再接线。第二步量一下线圈电阻。");
  assert.equal(c.trimmed, undefined);
});

test("说过太长之后的下一轮走极简档；失败回退也会截断原文", async (t) => {
  const f = await fixture(t);
  const u = await f.add("emp-tiny");
  const created = await f.ws.createVoiceTurn(u.user, {
    request_id: randomUUID(),
    question: "好了好了，你说的太多了",
    domain: domains[0],
  });
  const stored = await f.repo.get("turns", created.turn_id);
  assert.match(stored.system_prompt, /极简档/, "抱怨太长之后的下一轮要压到最低档");
  assert.match(stored.system_prompt, /不超过 100 字/);

  const raw = enumerated(120).join("\n");
  const tidied = tidyVoiceFailure(raw, "你看我这几张图，说说怎么做");
  assert.ok(tidied.length < 200, `失败回退也要截断，实际 ${tidied.length} 字`);
  assert.ok(points(tidied) <= 3, `最多 3 点，实际 ${points(tidied)}`);
});
