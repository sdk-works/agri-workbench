import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { openRepository } from "./repository.mjs";
import { createWorkspace, domains } from "./workspace.mjs";
import { createGateway } from "./model-gateway.mjs";
import { cleanParts, parseDocument } from "./documents.mjs";

import { fixture, result } from "./test-helpers.mjs";

test("authentication, CSRF marker, employee isolation and expert domain permissions", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee-a"),
    b = await f.add("employee-b"),
    expert = await f.add("expert-iot", "expert", [domains[1]]);
  assert.equal((await f.request("/turns")).status, 401);
  assert.equal((await f.request("/reviews", undefined, a.cookie)).status, 403);
  assert.equal((await f.request("/models", undefined, a.cookie)).status, 403);
  const turn = await f.turn(a.cookie);
  assert.equal(
    (await f.request("/turns", undefined, b.cookie)).data.items.length,
    0,
  );
  assert.equal(
    (await f.request(`/turns/${turn.id}/feedback`, { choice: "A" }, b.cookie))
      .status,
    404,
  );
  assert.equal(
    (
      await f.request(
        "/turns",
        {
          request_id: randomUUID(),
          question: "追问",
          conversation_id: turn.conversation_id,
        },
        b.cookie,
      )
    ).status,
    404,
  );
  await f.request(
    `/turns/${turn.id}/feedback`,
    { choice: "both_bad", actor: "forged" },
    a.cookie,
  );
  const feedback = await f.repo.get("feedback", `feedback-${turn.id}`);
  assert.equal(feedback.owner, a.user.id);
  const reviews = (await f.request("/reviews", undefined, f.admin)).data.items;
  assert.equal(reviews.length, 1);
  assert.equal(
    (await f.request("/reviews/" + reviews[0].id, undefined, expert.cookie))
      .status,
    403,
  );
  assert.deepEqual(
    (await f.request("/reviews", undefined, expert.cookie)).data.items,
    [],
  );
  const anonymous = await f.request("/auth/setup", {
    username: "evil",
    password: "test-password-123",
  });
  assert.equal(anonymous.status, 409);
});

test("automatic judge runs without feedback; similar results stay out of review and source remains hidden", async (t) => {
  let count = 0;
  const f = await fixture(t, {
      judge: async () => {
        count++;
        return result();
      },
    }),
    a = await f.add("employee");
  const turn = await f.turn(a.cookie);
  await f.ws.tick("judge");
  assert.equal(count, 1);
  const list = (await f.request("/turns", undefined, a.cookie)).data.items;
  assert(!list[0].judge);
  assert(!list[0].config_snapshot);
  assert(list[0].candidates.every((c) => !c.model && !c.role));
  assert.equal((await f.repo.list("reviews")).length, 0);
  await f.request(`/turns/${turn.id}/feedback`, { choice: "A" }, a.cookie);
  await f.ws.tick("judge");
  assert.equal(count, 1);
  assert.equal(
    (await f.request("/turns", undefined, a.cookie)).data.items[0].candidates[0]
      .model !== undefined,
    true,
  );
});

test("multi-turn context adopts exactly one answer; request id is idempotent", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee");
  const first = await f.turn(a.cookie);
  await f.request(`/turns/${first.id}/feedback`, { choice: "B" }, a.cookie);
  const second = await f.turn(a.cookie, "再解释一下", {
    conversation_id: first.conversation_id,
  });
  const saved = await f.repo.get("turns", second.id),
    original = await f.repo.get("turns", first.id);
  assert.equal(saved.context.length, 3);
  assert.equal(saved.context[1].content, original.candidates[1].text);
  assert.equal(saved.split, original.split);
  const same = await f.request(
    "/turns",
    {
      request_id: second.id,
      question: "再解释一下",
      conversation_id: first.conversation_id,
    },
    a.cookie,
  );
  assert.equal(same.status, 202);
  assert.equal((await f.repo.list("turns")).length, 2);
  assert.equal(
    (
      await f.request(
        "/turns",
        { request_id: second.id, question: "不同问题" },
        a.cookie,
      )
    ).status,
    409,
  );
});

test("material conflict routes before vote, duplicate cases group, critical review requires second expert", async (t) => {
  const f = await fixture(t, {
      judge: async () => ({
        ...result(),
        material_difference: true,
        conflicts: ["单位不同"],
      }),
    }),
    a = await f.add("employee"),
    x = await f.add("expert-one", "expert"),
    y = await f.add("expert-two", "expert");
  await f.turn(a.cookie);
  await f.ws.tick("judge");
  await f.turn(a.cookie);
  await f.ws.tick("judge");
  const reviews = await f.repo.list("reviews");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].turn_ids.length, 2);
  const id = reviews[0].id;
  assert.equal(
    (await f.request(`/reviews/${id}/claim`, {}, x.cookie)).status,
    200,
  );
  assert.equal(
    (await f.request(`/reviews/${id}/claim`, {}, y.cookie)).status,
    409,
  );
  assert.equal(
    (
      await f.request(
        `/reviews/${id}/save`,
        { revision: 0, answer: "正确答案", evidence: "已核实 SOP" },
        x.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.request(`/reviews/${id}/approve`, { revision: 1 }, x.cookie))
      .status,
    400,
  );
  assert.equal(
    (await f.request(`/reviews/${id}/approve`, { revision: 0 }, y.cookie))
      .status,
    409,
  );
  assert.equal(
    (
      await f.request(
        `/reviews/${id}/approve`,
        { revision: 1, preferred: "A", original_acceptable: true },
        y.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        `/reviews/${id}/save`,
        { revision: 1, answer: "覆盖", evidence: "覆盖" },
        x.cookie,
      )
    ).status,
    409,
  );
});

test("failed cloud judge is visible to admin, never auto-approves or blocks next generation", async (t) => {
  const f = await fixture(t, {
      judge: async () => {
        throw Object.assign(Error("模型服务 HTTP 429"), {
          code: "rate_limited",
        });
      },
    }),
    a = await f.add("employee");
  const turn = await f.turn(a.cookie);
  await f.ws.tick("judge");
  const stored = await f.repo.get("turns", turn.id);
  assert.equal(stored.judge.status, "failed");
  assert.equal((await f.repo.list("reviews")).length, 0);
  const j = (await f.repo.list("jobs")).find((j) => j.type === "judge");
  assert.equal(j.status, "failed");
  assert.equal(
    (await f.request(`/jobs/${j.id}/retry`, {}, a.cookie)).status,
    403,
  );
  assert.equal(
    (await f.request(`/jobs/${j.id}/retry`, {}, f.admin)).status,
    200,
  );
  await f.turn(a.cookie, "另一个问题");
});

test("normal review single expert approval and strict SFT/DPO/eval export gates", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee"),
    x = await f.add("expert-one", "expert");
  let turn;
  for (let i = 0; i < 20; i++) {
    const candidate = await f.turn(a.cookie, "资料解释 " + i);
    if ((await f.repo.get("turns", candidate.id)).split === "train") {
      turn = candidate;
      break;
    }
  }
  assert(turn);
  await f.request(
    `/turns/${turn.id}/feedback`,
    { choice: "both_bad" },
    a.cookie,
  );
  const r = (await f.repo.list("reviews"))[0];
  await f.request(
    `/reviews/${r.id}/save`,
    { revision: 0, answer: "专家标准答案", evidence: "SOP 第一章" },
    x.cookie,
  );
  assert.equal(
    (await f.request("/datasets/export", { kind: "sft" }, f.admin)).status,
    400,
  );
  await f.request(
    `/reviews/${r.id}/approve`,
    { revision: 1, issue_confirmed: true },
    x.cookie,
  );
  const sft = await f.request("/datasets/export", { kind: "sft" }, f.admin);
  assert.equal(sft.status, 200);
  assert.equal(sft.data.items[0].messages.at(-1).content, "专家标准答案");
  assert.equal(
    (await f.request("/datasets/export", { kind: "dpo" }, f.admin)).status,
    400,
  );
  assert.equal(
    (await f.request("/datasets/export", { kind: "sft" }, x.cookie)).status,
    403,
  );
  assert.equal((await f.repo.list("exports")).length, 1);
});

test("upload saves original, parses/redacts, domain-gates publication and retrieves only published text", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee"),
    other = await f.add("employee-two"),
    expert = await f.add("expert-one", "expert");
  const original = "番茄温度检查 13812345678\n番茄温度检查 13812345678";
  const payload = {
    name: "经验.txt",
    base64: Buffer.from(original).toString("base64"),
    domain: domains[0],
    source: "现场记录",
  };
  const uploaded = await f.request("/documents", payload, a.cookie);
  assert.equal(uploaded.status, 202);
  const id = uploaded.data.document.id;
  assert.equal(
    fs.readFileSync(path.join(f.dir, "uploads", id), "utf8"),
    original,
  );
  assert.equal(
    (await f.request("/documents", payload, a.cookie)).data.duplicate,
    true,
  );
  assert.equal(
    (await f.request("/documents/" + id, undefined, other.cookie)).status,
    404,
  );
  await f.ws.tick("parse");
  const d = (await f.request("/documents/" + id, undefined, expert.cookie))
    .data;
  assert.equal(d.status, "pending");
  assert(!d.cleaned_text.includes("13812345678"));
  assert(d.warnings.length);
  assert.equal(d.parts[1].duplicate, true);
  assert.equal(
    (
      await f.request(
        `/documents/${id}/publish`,
        { revision: 1, text: "番茄温度检查", checked: true, evidence: "记录" },
        a.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        `/documents/${id}/publish`,
        {
          revision: 1,
          text: "番茄温度检查，先核对传感器。",
          checked: true,
          evidence: "核对原始种植记录",
        },
        expert.cookie,
      )
    ).status,
    200,
  );
  const turn = await f.turn(a.cookie, "番茄温度检查");
  assert.equal(
    (await f.repo.get("turns", turn.id)).references[0].document_id,
    id,
  );
  assert.equal(
    (await f.request("/documents/" + id, undefined, other.cookie)).data
      .cleaned_text,
    undefined,
  );
});

test("restart recovery preserves partial generation and does not repeat paid request", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee");
  const created = await f.request(
    "/turns",
    { request_id: randomUUID(), question: "中断问题", domain: domains[0] },
    a.cookie,
  );
  const t1 = await f.repo.get("turns", created.data.id),
    j = (await f.repo.list("jobs"))[0];
  t1.candidates[0].status = "completed";
  t1.candidates[0].text = "已完成";
  await f.repo.transaction(async (db) => {
    await db.put("turns", t1);
    await db.put("jobs", { ...j, status: "running" });
  });
  await f.ws.recover();
  assert.equal((await f.repo.get("turns", t1.id)).status, "partial");
  await f.ws.tick("generate");
  assert.equal(f.calls.length, 0);
});

test("gateway routes independent cloud judge, masks keys, validates structure and marks fallback", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agri-gateway-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const parsed = { ...result() };
  for (const side of ["a", "b"])
    for (const dim of ["accuracy", "completeness", "actionable", "concise"])
      parsed[`${side}_${dim}`] = 4;
  const gw = createGateway(
    {
      JUDGE_BASE_URL: "https://judge.test/v1",
      JUDGE_CLOUD_MODEL: "judge-model",
      JUDGE_API_KEY: "private-test-key",
    },
    path.join(dir, "config.json"),
    {
      fetcher: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          json: async () =>
            url.endsWith("/api/chat")
              ? { message: { content: JSON.stringify(parsed) } }
              : { choices: [{ message: { content: JSON.stringify(parsed) } }] },
        };
      },
    },
  );
  assert(!JSON.stringify(gw.publicConfig()).includes("private-test-key"));
  const turn = {
    context: [],
    question: "问题",
    candidates: [
      { text: "A", model: "qwen2.5:7b" },
      { text: "B", model: "cloud-answer" },
    ],
  };
  const out = await gw.judge(turn);
  assert.equal(out.model, "judge-model");
  assert.equal(out.self_judging, false);
  assert.equal(calls[0].url, "https://judge.test/v1/chat/completions");
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer private-test-key",
  );
  assert(!calls[0].options.body.includes("feedback"));
  const fb = await gw.judge(turn, { fallback: true });
  assert.equal(fb.degraded, true);
  assert.equal(fb.self_judging, true);
  gw.save({
    judge: {
      adapter: "compatible",
      base_url: "https://other.test/v1",
      model: "judge-new",
      api_key: "",
    },
  });
  await gw.judge(turn);
  assert.equal(
    calls.at(-1).options.headers.Authorization,
    "Bearer private-test-key",
  );
});

test("cleaning preserves numeric signs and units and identifies duplicates", () => {
  const cleaned = cleanParts([
    { location: "1", text: " -5 °C  EC 2.0 mS/cm " },
    { location: "2", text: "-5 °C  EC 2.0 mS/cm" },
    { location: "3", text: "联系 a@test.com" },
  ]);
  assert(cleaned.text.includes("-5 °C"));
  assert.equal(cleaned.duplicates, 1);
  assert(!cleaned.text.includes("a@test.com"));
});

test("CSV, JSONL, DOCX and XLSX parsers preserve source positions", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agri-files-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of [
    ["data.csv", "crop,value\ntomato,2.5"],
    ["data.jsonl", '{"crop":"tomato"}\n{"crop":"pepper"}'],
  ]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const out = await parseDocument(file, name);
    assert.equal(out.parts.length, 2);
    assert(out.parts[1].location.includes("2"));
  }
  const ExcelJS = (await import("exceljs")).default,
    wb = new ExcelJS.Workbook();
  wb.addWorksheet("Sensors").addRow(["tomato", -5, "°C"]);
  const xlsx = path.join(dir, "data.xlsx");
  await wb.xlsx.writeFile(xlsx);
  const parsed = await parseDocument(xlsx, "data.xlsx");
  assert(parsed.text.includes("Sensors"));
  assert(parsed.text.includes("-5"));
  const JSZip = (await import("jszip")).default,
    zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>tomato standard</w:t></w:r></w:p></w:body></w:document>',
  );
  const docx = path.join(dir, "data.docx");
  fs.writeFileSync(docx, await zip.generateAsync({ type: "nodebuffer" }));
  assert(
    (await parseDocument(docx, "data.docx")).text.includes("tomato standard"),
  );
});

test("CSRF marker is required and disabling an account revokes existing sessions", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee");
  const rejected = await fetch(f.base + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password-123" }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(
    (await f.request("/users", { ...a.user, active: false }, f.admin)).status,
    201,
  );
  assert.equal((await f.request("/turns", undefined, a.cookie)).status, 401);
});

test("review budget defers ordinary cases while a later critical conflict upgrades priority", async (t) => {
  const f = await fixture(t, {
      judge: async () => ({ ...result(), conflicts: ["同一单位结论冲突"] }),
    }),
    a = await f.add("employee");
  await f.request(
    "/rules",
    { sample_rate: 0, review_daily_limit: 1, judge_attempts: 1 },
    f.admin,
  );
  const first = await f.turn(a.cookie, "普通说明甲");
  await f.request(
    `/turns/${first.id}/feedback`,
    { choice: "both_bad" },
    a.cookie,
  );
  const second = await f.turn(a.cookie, "普通说明乙");
  await f.request(
    `/turns/${second.id}/feedback`,
    { choice: "both_bad" },
    a.cookie,
  );
  let review = (await f.repo.list("reviews")).find(
    (r) => r.turn_id === second.id,
  );
  assert.equal(review.status, "deferred");
  await f.ws.tick("judge");
  await f.ws.tick("judge");
  review = await f.repo.get("reviews", review.id);
  assert.equal(review.critical, true);
  assert.equal(review.status, "queued");
});

test("evaluation isolation, DPO contents, revision history and database backup survive reopen", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee"),
    x = await f.add("expert-one", "expert");
  let item;
  for (let i = 0; i < 40; i++) {
    const out = await f.turn(a.cookie, "评测样本 " + i);
    const record = await f.repo.get("turns", out.id);
    if (record.split === "eval") {
      item = record;
      break;
    }
  }
  assert(item);
  await f.request(
    `/turns/${item.id}/feedback`,
    { choice: "both_bad" },
    a.cookie,
  );
  const r = (await f.repo.list("reviews"))[0];
  await f.request(
    `/reviews/${r.id}/save`,
    { revision: 0, answer: "专家答案第一版", evidence: "根据资料" },
    x.cookie,
  );
  await f.request(
    `/reviews/${r.id}/save`,
    { revision: 1, answer: "专家答案第二版", evidence: "根据资料与适用条件" },
    x.cookie,
  );
  assert.equal((await f.repo.list("review_versions")).length, 2);
  await f.request(
    `/reviews/${r.id}/approve`,
    { revision: 2, preferred: "B", original_acceptable: true },
    x.cookie,
  );
  assert.equal(
    (await f.request("/datasets/export", { kind: "sft" }, f.admin)).status,
    400,
  );
  assert.equal(
    (await f.request("/datasets/export", { kind: "dpo" }, f.admin)).status,
    400,
  );
  const out = await f.request("/datasets/export", { kind: "eval" }, f.admin);
  assert.equal(out.data.items[0].messages.at(-1).content, "专家答案第二版");
  const copy = path.join(f.dir, "copy.sqlite");
  await f.repo.backup(copy);
  const restored = await openRepository({ filename: copy });
  try {
    assert.equal((await restored.get("reviews", r.id)).revision, 2);
    assert.equal((await restored.list("exports")).length, 1);
    assert.equal((await restored.list("review_versions")).length, 2);
  } finally {
    await restored.close();
  }
});

test("valid text PDF is extracted with page provenance, empty scan is not silently accepted", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agri-pdf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  function pdf(content) {
    const stream = `BT /F1 12 Tf 20 100 Td (${content}) Tj ET`;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let out = "%PDF-1.4\n";
    const offsets = [0];
    for (let i = 0; i < objs.length; i++) {
      offsets.push(Buffer.byteLength(out));
      out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const pos = Buffer.byteLength(out);
    out += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((o) => String(o).padStart(10, "0") + " 00000 n ")
      .join(
        "\n",
      )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;
    return out;
  }
  const file = path.join(dir, "source.pdf");
  fs.writeFileSync(file, pdf("Tomato humidity"));
  const parsed = await parseDocument(file, "source.pdf");
  assert(parsed.text.includes("Tomato humidity"));
  assert.equal(parsed.parts[0].location, "第 1 页");
  fs.writeFileSync(file, pdf(""));
  await assert.rejects(() => parseDocument(file, "source.pdf"), /未提取到文字/);
});
