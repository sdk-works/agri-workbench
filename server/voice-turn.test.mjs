import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

async function freshUser(f, u) {
  return (await f.request("/auth/status", undefined, u.cookie)).data.user;
}

test("语音轮次：服务端先落库，幂等、状态与可恢复", async (t) => {
  const f = await fixture(t);
  const a = await f.add("emp-voice", "employee", [domains[0]]);

  const requestId = randomUUID();
  const t0 = Date.now();
  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: requestId,
    question: "大棚湿度高怎么办",
    domain: domains[0],
  });
  const writeMs = Date.now() - t0;
  assert.equal(created.duplicate, false);
  assert.ok(created.conversation_id);
  assert.ok(writeMs < 1000, "落库应在毫秒级，实测 " + writeMs + "ms");

  const stored = await f.repo.get("turns", created.turn.id);
  assert.equal(stored.source, "voice");
  assert.equal(stored.status, "generating");
  assert.equal(stored.candidates.length, 1);
  assert.equal(stored.candidates[0].label, "A");
  assert.equal(stored.judge.status, "skipped", "语音轮次不进裁判/评审");
  assert.equal(stored.references.length, 0);
  assert.equal((await f.repo.list("reviews")).length, 0);

  // 幂等：同一请求编号不重复建记录
  const again = await f.ws.createVoiceTurn(a.user, {
    request_id: requestId,
    question: "大棚湿度高怎么办",
    domain: domains[0],
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.turn.id, created.turn.id);
  assert.equal(
    (await f.repo.list("turns")).filter((x) => x.id === created.turn.id).length,
    1,
  );

  // 完成：保存全文与状态
  await f.ws.finishVoiceTurn(a.user, created.turn.id, {
    status: "completed",
    text: "多通风，早晚拉开风口。",
  });
  const done = await f.repo.get("turns", created.turn.id);
  assert.equal(done.status, "completed");
  assert.equal(done.candidates[0].status, "completed");
  assert.equal(done.candidates[0].text, "多通风，早晚拉开风口。");

  // 重复结束不再改写
  await f.ws.finishVoiceTurn(a.user, created.turn.id, {
    status: "failed",
    text: "覆盖尝试",
  });
  const still = await f.repo.get("turns", created.turn.id);
  assert.equal(still.status, "completed");
  assert.equal(still.candidates[0].text, "多通风，早晚拉开风口。");

  // 追问复用同一会话，并带上已完成的上下文
  const follow = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "那温度呢",
    conversation_id: created.conversation_id,
  });
  assert.equal(follow.conversation_id, created.conversation_id);
  const ctx = JSON.stringify(follow.messages);
  assert.ok(ctx.includes("多通风，早晚拉开风口。"), "追问应带上下文");

  // 失败也保留已生成部分
  await f.ws.finishVoiceTurn(a.user, follow.turn.id, {
    status: "failed",
    text: "温度控制在",
    error: "模型超时",
  });
  const failed = await f.repo.get("turns", follow.turn.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.candidates[0].text, "温度控制在");
  assert.equal(failed.candidates[0].error, "模型超时");
});

test("语音轮次：生成中禁止追问；取消也保留部分文本", async (t) => {
  const f = await fixture(t);
  const a = await f.add("emp-voice3", "employee", [domains[0]]);
  const r = await f.ws.createVoiceTurn(a.user, {
    request_id: randomUUID(),
    question: "湿度高怎么办",
    domain: domains[0],
  });
  await assert.rejects(
    () =>
      f.ws.createVoiceTurn(a.user, {
        request_id: randomUUID(),
        question: "继续",
        conversation_id: r.conversation_id,
      }),
    /仍在生成/,
  );
  await f.ws.finishVoiceTurn(a.user, r.turn.id, {
    status: "canceled",
    text: "说到一半",
    reason: "client_aborted",
  });
  const saved = await f.repo.get("turns", r.turn.id);
  assert.equal(saved.status, "canceled");
  assert.equal(saved.candidates[0].text, "说到一半");
  assert.equal(saved.ended_reason, "client_aborted");
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
    ...(await f.repo.get("turns", created.turn.id)),
    candidates: [
      { label: "A", role: "local", status: "generating", text: "已生成一半" },
    ],
  });
  await f.ws.recoverVoiceTurns();
  const recovered = await f.repo.get("turns", created.turn.id);
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
