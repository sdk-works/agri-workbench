import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

async function freshUser(f, u) {
  return (await f.request("/auth/status", undefined, u.cookie)).data.user;
}

async function seedDoc(f, u, domain) {
  const doc = {
    id: "doc-bx5",
    tenant: u.tenant,
    owner: u.id,
    domain,
    name: "BX-5 控制器通讯协议",
    revision: 1,
    status: "published",
    approved_text:
      "BX-5 控制器支持 9600 与 57600 两种通讯波特率，默认 9600，可通过设置指令切换。",
    created_at: new Date().toISOString(),
  };
  await f.repo.put("documents", doc);
  return doc;
}

test("语音轮次走统一编排：同一检索、单候选、来源标记、幂等", async (t) => {
  const f = await fixture(t);
  const a = await f.add("emp-voice", "employee", [domains[1]]);
  await seedDoc(f, a.user, domains[1]);

  const requestId = randomUUID();
  const t0 = Date.now();
  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: requestId,
    question: "BX-5 的通讯波特率是多少",
    domain: domains[1],
  });
  const writeMs = Date.now() - t0;
  assert.equal(created.duplicate, false);
  assert.ok(created.conversation_id);
  assert.ok(writeMs < 1500, "落库应在毫秒级，实测 " + writeMs + "ms");

  const stored = await f.repo.get("turns", created.turn_id);
  assert.equal(stored.source, "voice");
  assert.equal(stored.status, "generating");
  // 语音单路：只建一个候选，且默认走本地（30B/27B 按 tier 决定）
  assert.equal(stored.candidates.length, 1);
  assert.equal(stored.candidates[0].label, "A");
  assert.equal(stored.candidates[0].role, "local");
  assert.equal(stored.judge.status, "skipped", "语音单候选不进裁判");
  // 知识检索与文字一致：同一份资料被检索到
  assert.ok(stored.references.length >= 1, "语音必须带知识检索结果");
  assert.equal(stored.references[0].document_id, "doc-bx5");
  assert.match(stored.system_prompt, /语音播报要求/);
  assert.match(stored.system_prompt, /9600/, "参考资料应进提示词");

  // 先让语音轮次出队（同一用户排队额度与文字共用，这正是"统一编排"的表现）
  await f.ws.tick("generate");

  // 同一问题走文字：检索结果一致（这就是"共享知识库"的可验证口径）
  const textTurn = await f.ws.createTurn(a.user, {
    request_id: randomUUID(),
    question: "BX-5 的通讯波特率是多少",
    domain: domains[1],
  });
  const textStored = await f.repo.get("turns", textTurn.id);
  assert.deepEqual(
    textStored.references.map((r) => r.document_id),
    stored.references.map((r) => r.document_id),
  );
  assert.equal(textStored.candidates.length, 2, "文字仍是双候选");

  // 幂等
  const again = await f.ws.createVoiceTurn(a.user, {
    request_id: requestId,
    question: "BX-5 的通讯波特率是多少",
    domain: domains[1],
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.turn_id, created.turn_id);
  assert.equal(
    (await f.repo.list("turns")).filter((x) => x.id === created.turn_id).length,
    1,
  );
});

test("语音与文字共享同一会话上下文（生成完成后可追问）", async (t) => {
  const f = await fixture(t);
  const a = await f.add("emp-voice-ctx", "employee", [domains[1]]);

  const v1 = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "二号棚番茄叶片发黄怎么办",
    domain: domains[1],
  });
  await f.ws.tick("generate");
  const doneV = await f.repo.get("turns", v1.turn_id);
  assert.equal(doneV.status, "completed");
  assert.equal(doneV.candidates[0].status, "completed");
  const answer = doneV.candidates[0].text;
  assert.ok(answer.length > 0);

  // 文字追问同一会话：必须带上语音轮次的回答
  const t2 = await f.ws.createTurn(a.user, {
    request_id: randomUUID(),
    question: "那湿度呢",
    conversation_id: v1.conversation_id,
  });
  const t2s = await f.repo.get("turns", t2.id);
  assert.ok(
    JSON.stringify(t2s.context).includes(answer),
    "文字追问必须继承语音轮次的回答",
  );

  // 反向：语音追问文字轮次
  await f.ws.tick("generate");
  const v3 = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "那温度呢",
    conversation_id: v1.conversation_id,
  });
  const v3s = await f.repo.get("turns", v3.turn_id);
  assert.ok(
    JSON.stringify(v3s.context).includes("local 有效答案"),
    "语音追问必须继承文字轮次的回答",
  );
});

test("语音轮次：追读视图、取消语义、生成中禁止追问", async (t) => {
  const f = await fixture(t);
  const a = await f.add("emp-voice3", "employee", [domains[0]]);

  const r = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "湿度高怎么办",
    domain: domains[0],
  });

  const view = await f.ws.voiceTurnView(a.user, r.turn_id);
  assert.equal(view.status, "generating");
  assert.equal(view.source, "voice");

  await assert.rejects(
    () =>
      f.ws.createVoiceTurn(a.user, {
        request_id: randomUUID(),
        question: "继续",
        conversation_id: r.conversation_id,
      }),
    /仍在生成/,
  );

  // 越权读不到别人的轮次
  const b = await f.add("emp-voice4", "employee", [domains[0]]);
  assert.equal(await f.ws.voiceTurnView(b.user, r.turn_id), null);

  // 排队阶段取消：与文字同一套 cancelJob，不产生"假完成"
  const canceled = await f.ws.cancelTurn(a.user, r.turn_id);
  assert.equal(canceled.status, "failed");
  const after = await f.repo.get("turns", r.turn_id);
  assert.equal(after.status, "failed");
  assert.equal(after.candidates[0].status, "failed");
  assert.equal(after.candidates[0].error_code, "canceled");
});

test("语音轮次：调岗后不能继续原会话；重启可恢复中断记录", async (t) => {
  const f = await fixture(t);
  const a = await f.add("emp-voice2", "employee", [domains[0]]);
  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "湿度高怎么办",
    domain: domains[0],
  });

  // 重启恢复：遗留 generating → failed，保留文本
  await f.repo.put("turns", {
    ...(await f.repo.get("turns", created.turn_id)),
    candidates: [
      { label: "A", role: "local", status: "generating", text: "已生成一半" },
    ],
  });
  await f.ws.recoverVoiceTurns();
  const recovered = await f.repo.get("turns", created.turn_id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.ended_reason, "interrupted");
  assert.equal(recovered.candidates[0].text, "已生成一半");

  // 调岗后原会话不可续
  const depts = (await f.request("/departments", undefined, f.admin)).data.items;
  const d1 = depts.find((d) => d.name === domains[1]);
  await f.request(
    "/users",
    {
      id: a.user.id,
      username: a.user.username,
      name: a.user.name,
      role: "employee",
      dept_ids: [d1.id],
      active: true,
    },
    f.admin,
  );
  const moved = await freshUser(f, a);
  await assert.rejects(
    () =>
      f.ws.createVoiceTurn(moved, {
        request_id: randomUUID(),
        question: "继续问",
        conversation_id: created.conversation_id,
      }),
    /无权/,
  );
});
