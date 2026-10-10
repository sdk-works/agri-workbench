import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { fixture } from "./test-helpers.mjs";
import { digest } from "./documents.mjs";
import {
  validateAnnotation,
  validateDataset,
  datasetOverlap,
} from "./asset-schema.mjs";

const sourceText =
  "番茄湿度检查需要核对传感器单位、采集时间和作物生育期。缺少条件时应先澄清。";

test("single knowledge downloads enforce approval, versions and matching MD/JSON", async (t) => {
  const f = await fixture(t),
    employee = await f.add("employee"),
    expert = await f.add("expert", "expert");
  const d = await source(f, employee, expert);
  const url = `${f.base}/documents/${d.id}/knowledge`;
  const get = (suffix = "", cookie = expert.cookie) =>
    fetch(url + suffix, { headers: { Cookie: cookie } });
  assert.equal((await get()).status, 409);
  await annotate(f, d, expert);
  const json = await get("?format=json");
  assert.equal(json.status, 200);
  assert(json.headers.get("etag"));
  const record = await json.json();
  const md = await get("?format=md");
  assert.equal(md.status, 200);
  assert((await md.text()).includes(record.content));
  assert.equal(record.content, sourceText);
  assert.equal((await get("?document_revision=999")).status, 409);
  assert.equal((await get("?format=exe")).status, 400);
  assert.equal((await get("", employee.cookie)).status, 403);
  assert.equal(
    (await f.request("/imports", null, employee.cookie)).status,
    400,
  );
});

test("restart recovers frozen asset jobs but does not repeat interrupted model calls", async (t) => {
  const f = await fixture(t);
  for (const [id, type, status] of [
    ["zip", "assets", "running"],
    ["candidate", "candidates", "running"],
    ["done", "candidates", "completed"],
  ]) {
    await f.repo.put(
      type === "assets" ? "asset_exports" : "candidate_batches",
      { id, tenant: "park", status },
    );
    await f.repo.put("jobs", {
      id: `job-${id}`,
      resource_id: id,
      type,
      tenant: "park",
      status: "running",
    });
  }
  await f.ws.recover();
  assert.equal((await f.repo.get("asset_exports", "zip")).status, "queued");
  assert.equal((await f.repo.get("jobs", "job-zip")).status, "queued");
  assert.equal(
    (await f.repo.get("candidate_batches", "candidate")).status,
    "failed",
  );
  assert.equal((await f.repo.get("jobs", "job-candidate")).status, "failed");
  assert.equal((await f.repo.get("jobs", "job-done")).status, "completed");
  assert.equal(f.calls.length, 0);
});
async function source(f, employee, expert) {
  const uploaded = await f.request(
    "/documents",
    {
      name: "番茄规范.txt",
      base64: Buffer.from(sourceText).toString("base64"),
      domain: "种植管理",
      source: "园区 SOP v1",
    },
    employee.cookie,
  );
  assert.equal(uploaded.status, 202);
  const id = uploaded.data.document.id;
  await f.ws.tick("parse");
  const published = await f.request(
    `/documents/${id}/publish`,
    {
      revision: 1,
      text: sourceText,
      checked: true,
      evidence: "专家核对园区记录",
    },
    expert.cookie,
  );
  assert.equal(published.status, 200);
  return published.data;
}
async function annotate(f, d, expert) {
  const a = await f.request(
    `/documents/${d.id}/annotation`,
    {
      revision: 0,
      document_revision: d.revision,
      fields: {
        title: "番茄湿度核查",
        crop: "番茄",
        growth_stage: null,
        applicable_conditions: ["条件不足时先澄清"],
        evidence_locations: ["段落 1"],
      },
    },
    expert.cookie,
  );
  assert.equal(a.status, 200);
  const approved = await f.request(
    `/documents/${d.id}/annotation/approve`,
    {
      revision: a.data.revision,
      checked: true,
      evidence: "对照原文，未提供的字段保留空值",
    },
    expert.cookie,
  );
  assert.equal(approved.status, 200);
  return approved.data;
}
function dataset(kind, id, question, sourceId = "source-" + id) {
  return {
    id,
    tenant: "park",
    owner: "admin",
    created_at: new Date().toISOString(),
    kind,
    items: [
      {
        messages: [
          { role: "user", content: question },
          { role: "assistant", content: "经审核的标准答案" },
        ],
        meta: {
          domain: "种植管理",
          revision: 1,
          split: kind === "eval" ? "eval" : "train",
          approval: { actor: "expert" },
          sources: [{ document_id: sourceId, version: 1 }],
        },
      },
    ],
  };
}

test("structured annotations enforce schema, domain permissions and revision-bound approval", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee"),
    expert = await f.add("expert", "expert"),
    other = await f.add("iot-expert", "expert", ["农业物联网"]),
    d = await source(f, a, expert);
  assert.equal(
    (
      await f.request(
        `/documents/${d.id}/annotation`,
        {
          revision: 0,
          document_revision: d.revision,
          fields: { title: "坏字段", unknown: "x" },
        },
        expert.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        `/documents/${d.id}/annotation`,
        {
          revision: 0,
          document_revision: d.revision,
          fields: { title: "标题" },
        },
        a.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.request(`/documents/${d.id}/annotation`, undefined, other.cookie))
      .status,
    403,
  );
  const approved = await annotate(f, d, expert);
  assert.equal(approved.fields.growth_stage, null);
  assert.deepEqual(approved.fields.keywords, []);
  assert.equal(
    (
      await f.request(
        `/documents/${d.id}/annotation`,
        {
          revision: 1,
          document_revision: d.revision,
          fields: { title: "覆盖" },
        },
        expert.cookie,
      )
    ).status,
    409,
  );
  assert.equal((await f.repo.list("annotation_versions")).length, 2);
  assert.equal(
    (await f.request(`/documents/${d.id}/ocr`, {}, a.cookie)).status,
    503,
  );
  const report = await f.request(
    `/documents/${d.id}/cleaning-report`,
    undefined,
    a.cookie,
  );
  assert.equal(report.data.parser_status, "completed");
  assert.equal(report.data.source_sha256, d.hash);
});

test("asset ZIP freezes MD/JSON versions, validates checksums, excludes drafts and enforces download scope", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee"),
    expert = await f.add("expert", "expert"),
    d = await source(f, a, expert);
  const payload = {
    request_id: randomUUID(),
    document_ids: [d.id],
    include_originals: true,
  };
  assert.equal(
    (await f.request("/asset-exports", payload, expert.cookie)).status,
    409,
  );
  await annotate(f, d, expert);
  const created = await f.request("/asset-exports", payload, expert.cookie);
  assert.equal(created.status, 202);
  assert(!created.data.snapshot);
  assert.equal(
    (await f.request("/asset-exports", payload, expert.cookie)).data.id,
    created.data.id,
  );
  // A later edit must not silently change the package that has already been requested.
  await f.request(
    `/documents/${d.id}/publish`,
    {
      revision: d.revision,
      text: "新的已审核内容",
      checked: true,
      evidence: "更新",
    },
    expert.cookie,
  );
  await f.ws.tick("assets");
  const state = (
    await f.request(
      "/asset-exports/" + created.data.id,
      undefined,
      expert.cookie,
    )
  ).data;
  assert.equal(state.status, "completed", JSON.stringify(state));
  const downloaded = await fetch(
    `${f.base}/asset-exports/${state.id}/download`,
    { headers: { Cookie: expert.cookie } },
  );
  assert.equal(downloaded.status, 200);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(digest(bytes), state.sha256);
  const zip = await JSZip.loadAsync(bytes),
    manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  for (const file of manifest.files) {
    assert.equal(
      digest(await zip.file(file.path).async("nodebuffer")),
      file.sha256,
    );
  }
  const knowledge = JSON.parse(
      await zip.file(`annotations/${d.id}.json`).async("string"),
    ),
    md = await zip.file(`knowledge/${d.id}.md`).async("string");
  assert.equal(knowledge.content, sourceText);
  assert(md.includes(knowledge.content));
  assert.equal(knowledge.document_revision, 2);
  assert(zip.file(`originals/${d.id}.txt`));
  assert.equal(
    (
      await fetch(`${f.base}/asset-exports/${state.id}/download`, {
        headers: { Cookie: a.cookie },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(
        "/asset-exports",
        { ...payload, request_id: randomUUID() },
        expert.cookie,
      )
    ).status,
    409,
  );
  const artifact = path.join(
    f.dir,
    "uploads",
    "asset-packages",
    `${state.id}.zip`,
  );
  fs.appendFileSync(artifact, "changed");
  assert.equal(
    (
      await fetch(`${f.base}/asset-exports/${state.id}/download`, {
        headers: { Cookie: expert.cookie },
      })
    ).status,
    409,
  );
});

test("batch manifest supports resumable per-file upload, idempotency, progress and parser retry", async (t) => {
  const f = await fixture(t),
    a = await f.add("employee"),
    other = await f.add("another");
  const manifest = {
    request_id: randomUUID(),
    items: [{ name: "invalid.jsonl", domain: "种植管理", source: "录入文件" }],
  };
  const created = await f.request("/imports", manifest, a.cookie);
  assert.equal(created.status, 201);
  const { id, items } = created.data;
  assert.equal((await f.request("/imports", manifest, a.cookie)).data.id, id);
  assert.equal(
    (await f.request("/imports/" + id, undefined, other.cookie)).status,
    404,
  );
  const endpoint = `/imports/${id}/items/${items[0].id}`,
    base64 = Buffer.from("not json").toString("base64");
  const uploaded = await f.request(endpoint, { base64 }, a.cookie);
  assert.equal(uploaded.status, 202);
  assert.equal(
    (await f.request(endpoint, { base64 }, a.cookie)).data.document_id,
    uploaded.data.document_id,
  );
  assert.equal(
    (
      await f.request(
        endpoint,
        { base64: Buffer.from("other").toString("base64") },
        a.cookie,
      )
    ).status,
    409,
  );
  await f.ws.tick("parse");
  const batch = await f.request("/imports/" + id, undefined, a.cookie);
  assert.equal(batch.data.progress.failed, 1);
  const docId = uploaded.data.document_id;
  assert.equal(
    (await f.request(`/documents/${docId}/retry`, {}, other.cookie)).status,
    404,
  );
  assert.equal(
    (await f.request(`/documents/${docId}/retry`, {}, a.cookie)).status,
    202,
  );
  assert.equal((await f.repo.get("jobs", "parse-" + docId)).status, "queued");
});

test("grounded AI candidates require expert promotion and review, never enter datasets automatically", async (t) => {
  const f = await fixture(t, {
    call: async () => ({
      answer: JSON.stringify({
        items: [
          {
            question: "番茄湿度检查要核对什么？",
            answer: sourceText,
            source_quote:
              "番茄湿度检查需要核对传感器单位、采集时间和作物生育期。",
            type: "现场判断",
          },
        ],
      }),
      model: "independent-generator",
      provider: "cloud",
    }),
  });
  const a = await f.add("employee"),
    expert = await f.add("expert", "expert"),
    d = await source(f, a, expert);
  const payload = {
    request_id: randomUUID(),
    document_id: d.id,
    document_revision: d.revision,
    count: 2,
    types: ["现场判断"],
    model_role: "local",
  };
  assert.equal(
    (await f.request("/candidate-batches", payload, a.cookie)).status,
    403,
  );
  const created = await f.request("/candidate-batches", payload, expert.cookie);
  assert.equal(created.status, 202);
  assert(!created.data.source.text);
  await f.ws.tick("candidates");
  const batch = (
    await f.request(
      "/candidate-batches/" + created.data.id,
      undefined,
      expert.cookie,
    )
  ).data;
  assert.equal(batch.status, "completed", JSON.stringify(batch));
  assert.equal(batch.items.length, 1);
  assert.equal((await f.repo.list("reviews")).length, 0);
  assert.equal((await f.repo.list("exports")).length, 0);
  const candidate = batch.items[0],
    promotion = {
      revision: 1,
      answer: sourceText,
      evidence: "SOP 逐字核对",
      checked: true,
    };
  const promoted = await f.request(
    `/candidates/${candidate.id}/promote`,
    promotion,
    expert.cookie,
  );
  assert.equal(promoted.status, 200);
  assert.equal(
    (
      await f.request(
        `/candidates/${candidate.id}/promote`,
        promotion,
        expert.cookie,
      )
    ).data.review_id,
    promoted.data.review_id,
  );
  const review = await f.repo.get("reviews", promoted.data.review_id);
  assert.equal(review.status, "awaiting_review");
  assert.equal((await f.repo.list("reviews")).length, 1);
  assert.equal(
    (
      await f.request(
        `/reviews/${review.id}/approve`,
        { revision: 1, preferred: "A", original_acceptable: true },
        expert.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        `/reviews/${review.id}/approve`,
        { revision: 1 },
        expert.cookie,
      )
    ).status,
    200,
  );
});

test("fabricated candidate citations fail without leaking candidate records; retry stays explicit", async (t) => {
  const f = await fixture(t, {
      call: async () => ({
        answer: JSON.stringify({
          items: [
            {
              question: "伪造问题",
              answer: "伪造答案",
              source_quote: "资料中完全不存在的引用",
              type: "知识解释",
            },
          ],
        }),
        model: "mock",
        provider: "local",
      }),
    }),
    a = await f.add("employee"),
    expert = await f.add("expert", "expert"),
    d = await source(f, a, expert);
  const batch = await f.request(
    "/candidate-batches",
    {
      request_id: randomUUID(),
      document_id: d.id,
      document_revision: d.revision,
      count: 1,
    },
    expert.cookie,
  );
  await f.ws.tick("candidates");
  assert.equal(
    (await f.repo.get("candidate_batches", batch.data.id)).status,
    "failed",
  );
  assert.equal((await f.repo.list("candidates")).length, 0);
  assert.equal(
    (
      await f.request(
        `/candidate-batches/${batch.data.id}/retry`,
        {},
        expert.cookie,
      )
    ).status,
    202,
  );
});

test("dataset preflight detects format errors, identical DPO pairs and train/eval contamination", () => {
  const train = dataset("sft", "train", "番茄问题"),
    evaluation = dataset("eval", "eval", "另一个问题");
  assert(validateDataset(train).valid);
  assert.equal(validateDataset(train).runtime_validated, false);
  assert.deepEqual(datasetOverlap(train, evaluation), {
    questions: 0,
    sources: 0,
  });
  evaluation.items[0].messages[0].content = "番茄 问题";
  assert.equal(datasetOverlap(train, evaluation).questions, 1);
  const duplicate = structuredClone(train);
  duplicate.items.push(duplicate.items[0]);
  assert(!validateDataset(duplicate).valid);
  const dpo = {
    id: "dpo",
    kind: "dpo",
    items: [
      {
        prompt: [{ role: "user", content: "问题" }],
        chosen: [{ role: "assistant", content: "相同" }],
        rejected: [{ role: "assistant", content: "相同" }],
        meta: {
          ...train.items[0].meta,
          approval: { actor: "expert", original_acceptable: true },
        },
      },
    ],
  };
  assert(
    validateDataset(dpo).errors.some(
      (e) => e.code === "IDENTICAL_PREFERENCE_PAIR",
    ),
  );
  assert.throws(() => validateAnnotation({ title: "标注", crop: 123 }), /类型/);
});

test("training interfaces pin reviewed versions; missing executor returns 503 without claiming execution", async (t) => {
  const f = await fixture(t),
    employee = await f.add("employee");
  await f.repo.transaction(async (db) => {
    await db.put("exports", dataset("sft", "train-good", "训练问题"));
    await db.put("exports", dataset("eval", "eval-good", "评测问题"));
  });
  const payload = {
    request_id: randomUUID(),
    name: "农业首轮训练",
    method: "sft",
    base_model: "Qwen/example-training-base",
    train_export_id: "train-good",
    eval_export_id: "eval-good",
    hyperparameters: { epochs: 1, lora_rank: 16 },
  };
  assert.equal(
    (await f.request("/training/jobs", payload, employee.cookie)).status,
    403,
  );
  const created = await f.request("/training/jobs", payload, f.admin);
  assert.equal(created.status, 201);
  assert.equal(created.data.status, "draft");
  assert.equal(
    (await f.request("/training/jobs", payload, f.admin)).data.id,
    created.data.id,
  );
  const started = await f.request(
    `/training/jobs/${created.data.id}/start`,
    {},
    f.admin,
  );
  assert.equal(started.status, 503);
  assert.equal(started.data.code, "TRAINING_EXECUTOR_NOT_CONFIGURED");
  assert.equal(
    (await f.repo.get("training_jobs", created.data.id)).status,
    "draft",
  );
  assert.equal(
    (await f.request(`/training/jobs/${created.data.id}/cancel`, {}, f.admin))
      .data.status,
    "cancelled",
  );
  assert.equal(
    (await f.request(`/training/jobs/${created.data.id}/start`, {}, f.admin))
      .status,
    409,
  );
  const capabilities = (await f.request("/capabilities", undefined, f.admin))
    .data;
  assert.equal(capabilities.training.configured, false);
  assert.equal(capabilities.asset_packages, true);
});
