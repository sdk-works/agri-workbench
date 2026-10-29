/**
 * 隔离验收补充用例（2026-10-29）：并发原子性 / 只读对账 / 取消终态 / 旧会话可追踪
 *
 * 这四项都不是"再跑一遍既有用例"：
 *   - 既有 night-voice-regression 只覆盖同一 request_id 的**串行**重放，没有并发；
 *   - 前端「状态待确认」原来靠重发 POST 去撞 duplicate 分支，属于写路径，没有只读查证；
 *   - 取消只测了"点了能停"，没有测终态幂等，也没有测"收尾晚于取消"的覆盖竞态；
 *   - 切走会话后没有任何入口能再看到上一会话还在生成的那条。
 *
 * 运行：node --test server/request-id-atomic.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";

const DOMAIN = "种植管理";

const listTurns = (f, u) =>
  f.repo.list("turns", { tenant: u.tenant, owner: u.id });

test("并发原子性：同一 request_id 8 路并发只建一条轮次、只跑一次生成", async (t) => {
  const f = await fixture(t);
  const a = await f.add("atomic-emp", "employee", [DOMAIN]);
  const rid = randomUUID();
  const body = { request_id: rid, question: "并发提同一个问题", domain: DOMAIN };

  // 真并发打同一个路由：不是顺序重放，检查的是 createTurn 里
  // 「get → put」是否真的在同一个事务里互斥
  const outs = await Promise.all(
    Array.from({ length: 8 }, () => f.request("/turns", body, a.cookie)),
  );
  for (const o of outs) {
    assert.equal(o.status, 202, JSON.stringify(o.data));
    assert.equal(o.data.id, rid, "8 路必须都指向同一个轮次");
  }

  const rows = (await listTurns(f, a.user)).filter((x) => x.id === rid);
  assert.equal(rows.length, 1, "只能有一条轮次");
  assert.equal(rows[0].status, "generating");

  const jobs = (await f.repo.list("jobs", { tenant: a.user.tenant })).filter(
    (j) => j.turn_id === rid,
  );
  assert.equal(jobs.length, 1, "只能排一个生成任务，不能每个请求各排一个");

  const expected = rows[0].candidates.length;
  assert.equal(f.calls.length, 0, "建轮次阶段不许直接调模型");
  await f.ws.tick("generate");
  assert.equal(f.calls.length, expected, "只跑一轮生成，不因并发变成多轮");
});

test("只读对账：GET /turns/:id 不建轮次、不改状态、不调模型、不泄露他人", async (t) => {
  const f = await fixture(t);
  const a = await f.add("recon-emp", "employee", [DOMAIN]);
  const rid = randomUUID();

  // 1) 还没建过：明确回 found=false，且库里不能因为这次查询多出任何东西
  const miss = await f.request(`/turns/${rid}`, undefined, a.cookie);
  assert.equal(miss.status, 200);
  assert.equal(miss.data.found, false);
  assert.equal((await listTurns(f, a.user)).length, 0, "对账不许建轮次");
  assert.equal(f.calls.length, 0, "对账不许调模型");

  // 2) 建好之后查得到，且查询本身不推进状态机
  const made = await f.request(
    "/turns",
    { request_id: rid, question: "对账用的问题", domain: DOMAIN },
    a.cookie,
  );
  assert.equal(made.status, 202);
  const before = await f.repo.get("turns", rid);
  const hit = await f.request(`/turns/${rid}`, undefined, a.cookie);
  assert.equal(hit.data.found, true);
  assert.equal(hit.data.turn.id, rid);
  assert.equal(hit.data.turn.question, "对账用的问题");
  const after = await f.repo.get("turns", rid);
  assert.equal(after.status, before.status, "只读对账不许改状态");
  assert.equal(after.created_at, before.created_at);
  assert.deepEqual(
    after.candidates.map((c) => c.status),
    before.candidates.map((c) => c.status),
    "候选状态不许被查询推进",
  );
  assert.equal(f.calls.length, 0, "只读对账期间模型调用数必须还是 0");

  // 3) 同一个 id 再 POST 一次仍然幂等（对账与提交两条路不打架）
  const again = await f.request(
    "/turns",
    { request_id: rid, question: "对账用的问题", domain: DOMAIN },
    a.cookie,
  );
  assert.equal(again.status, 202);
  assert.equal(again.data.id, rid);
  assert.equal((await listTurns(f, a.user)).filter((x) => x.id === rid).length, 1);

  // 4) 换人查同一个 id：不告诉对方"这条存在"
  const b = await f.add("recon-other", "employee", [DOMAIN]);
  const other = await f.request(`/turns/${rid}`, undefined, b.cookie);
  assert.equal(other.status, 200);
  assert.equal(other.data.found, false, "别人的轮次必须按不存在处理");
});

test("只读对账：不同问题复用同一 request_id 仍被拒（防止编号被借走）", async (t) => {
  const f = await fixture(t);
  const a = await f.add("recon-dup", "employee", [DOMAIN]);
  const rid = randomUUID();
  await f.request(
    "/turns",
    { request_id: rid, question: "第一个问题", domain: DOMAIN },
    a.cookie,
  );
  const conflict = await f.request(
    "/turns",
    { request_id: rid, question: "另一个问题", domain: DOMAIN },
    a.cookie,
  );
  assert.equal(conflict.status, 409);
  assert.equal((await listTurns(f, a.user)).length, 1);
});

test("取消终态：排队取消→canceled，再点回同一终态，收尾晚到也不能翻成 completed", async (t) => {
  const f = await fixture(t);
  const a = await f.add("cancel-emp", "employee", [DOMAIN]);
  const rid = randomUUID();
  await f.request(
    "/turns",
    { request_id: rid, question: "取消终态用例", domain: DOMAIN },
    a.cookie,
  );

  // 排队中取消：必须当场落终态，并明确告诉前端"服务端已确认"
  const c1 = await f.request(`/turns/${rid}/cancel`, {}, a.cookie);
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  assert.equal(c1.data.status, "canceled");
  assert.equal(c1.data.cancel_confirmed, true);
  assert.equal((await f.repo.get("turns", rid)).ended_reason, "canceled");

  // 重复点停止：不能 404、不能变状态，只能回 already_terminal
  const c2 = await f.request(`/turns/${rid}/cancel`, {}, a.cookie);
  assert.equal(c2.status, 200, "终态后再取消不许 404");
  assert.equal(c2.data.status, "canceled");
  assert.equal(c2.data.already_terminal, true);

  // 已取消的 job 不会被执行：跑调度也不会把这条捞起来
  await f.ws.tick("generate");
  assert.equal(f.calls.length, 0, "已取消的轮次不许再花模型调用");
  assert.equal((await f.repo.get("turns", rid)).status, "canceled");
});

test("取消终态：取消意图已落库但生成先跑完，收尾必须钉成 canceled 且保留文字", async (t) => {
  const f = await fixture(t);
  const a = await f.add("cancel-race", "employee", [DOMAIN]);
  const rid = randomUUID();
  await f.request(
    "/turns",
    { request_id: rid, question: "取消竞态用例", domain: DOMAIN },
    a.cookie,
  );

  // 构造竞态：用户点停止的意图已经写入轮次，但中止信号晚于最后一次写库。
  // 这是真实链路上"点了停止却显示完成"的唯一来源，必须由收尾判定兜住。
  await f.repo.transaction(async (db) => {
    const tr = await db.get("turns", rid);
    await db.put("turns", {
      ...tr,
      cancel_requested_at: new Date().toISOString(),
    });
  });
  await f.ws.tick("generate");

  const after = await f.repo.get("turns", rid);
  assert.equal(after.status, "canceled", "取消是终态，不能被收尾覆盖成 completed");
  assert.equal(after.ended_reason, "canceled");
  const text = after.candidates.map((c) => String(c.text || "")).join("");
  assert.ok(text.trim().length > 0, "取消也要保留已经生成的文字，不能清空");
  assert.ok(
    after.candidates.some((c) => c.status === "completed"),
    "候选本身可以已完成，但整轮状态仍是 canceled",
  );
});

test("取消终态：运行中取消先回 cancel_pending，不谎报已确认", async (t) => {
  const f = await fixture(t);
  const a = await f.add("cancel-run", "employee", [DOMAIN]);
  const rid = randomUUID();
  await f.request(
    "/turns",
    { request_id: rid, question: "运行中取消", domain: DOMAIN },
    a.cookie,
  );
  // 把任务推进到 running：模拟"正在流式生成"
  await f.repo.transaction(async (db) => {
    const j = await db.get("jobs", `generate-${rid}`);
    await db.put("jobs", { ...j, status: "running" });
  });
  const c = await f.request(`/turns/${rid}/cancel`, {}, a.cookie);
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.cancel_confirmed, false, "中止刚发出时不能谎报服务端已确认");
  assert.equal(c.data.cancel_pending, true);
  const saved = await f.repo.get("turns", rid);
  assert.ok(saved.cancel_requested_at, "取消意图必须落库，收尾才有依据");
});

test("旧会话可追踪：切走会话后 active=1 仍列出在跑的轮次，跑完自动消失", async (t) => {
  const f = await fixture(t);
  const a = await f.add("track-emp", "employee", [DOMAIN]);
  const rid = randomUUID();
  const made = await f.request(
    "/turns",
    { request_id: rid, question: "后台还在跑的这条", domain: DOMAIN },
    a.cookie,
  );
  assert.equal(made.status, 202);

  // 不指定会话时服务端会建一个；下面用一个"别的会话"的视角确认它不会出现在
  // 当前会话列表里，但仍然能通过 active 查回来 —— 这就是"可追踪"
  const otherConv = await f.request(
    "/conversations",
    { title: "另一个会话", domain: DOMAIN },
    a.cookie,
  );
  const otherId = otherConv.data?.conversation?.id || otherConv.data?.id;
  if (otherId) {
    const scoped = await f.request(
      `/turns?conversation_id=${otherId}`,
      undefined,
      a.cookie,
    );
    assert.equal(
      scoped.data.items.filter((x) => x.id === rid).length,
      0,
      "当前会话视角不应包含别的会话的轮次",
    );
  }

  const active = await f.request("/turns?active=1", undefined, a.cookie);
  assert.equal(active.status, 200);
  assert.equal(active.data.items.length, 1);
  assert.equal(active.data.items[0].id, rid);
  assert.equal(active.data.items[0].status, "generating");
  assert.ok(active.data.items[0].question.includes("后台还在跑"));

  // 别人看不到这条
  const b = await f.add("track-other", "employee", [DOMAIN]);
  const otherActive = await f.request("/turns?active=1", undefined, b.cookie);
  assert.equal(otherActive.data.items.length, 0, "后台任务列表按人隔离");

  // 跑完就不再是"在跑"
  await f.ws.tick("generate");
  const done = await f.request("/turns?active=1", undefined, a.cookie);
  assert.equal(done.data.items.length, 0);
});
