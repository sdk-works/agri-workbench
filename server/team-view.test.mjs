import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

test("团队提问：管理员按部门可见，员工不可见", async (t) => {
  const f = await fixture(t);
  const a = await f.add("team-a", "employee", [domains[0]]);
  const b = await f.add("team-b", "employee", [domains[1]]);
  const mgr = await f.add("team-mgr", "manager", [domains[0]]);

  const ta = await f.turn(a.cookie, "种植部门的问题", { domain: domains[0] });
  const tb = await f.turn(b.cookie, "物联网部门的问题", { domain: domains[1] });

  // 员工不能看团队
  assert.equal(
    (await f.request("/conversations?scope=team", undefined, a.cookie)).status,
    403,
  );

  // 部门管理员只看本部门
  const convs = (
    await f.request("/conversations?scope=team", undefined, mgr.cookie)
  ).data.items;
  assert.ok(convs.some((c) => c.id === ta.conversation_id));
  assert.ok(!convs.some((c) => c.id === tb.conversation_id));

  const turns = (
    await f.request(
      "/turns?scope=team&conversation_id=" + ta.conversation_id,
      undefined,
      mgr.cookie,
    )
  ).data.items;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, "种植部门的问题");
  assert.equal(turns[0].owner_name, "team-a");
  assert.equal(turns[0].context, undefined, "团队视图不能拿到完整上下文");

  // 另一个部门的会话：即使指定 ID 也拿不到内容
  const other = (
    await f.request(
      "/turns?scope=team&conversation_id=" + tb.conversation_id,
      undefined,
      mgr.cookie,
    )
  ).data.items;
  assert.equal(other.length, 0);
});

test("团队提问：关键词、部门、成员筛选与统计", async (t) => {
  const f = await fixture(t);
  const a = await f.add("f-a", "employee", [domains[0]]);
  const b = await f.add("f-b", "employee", [domains[1]]);
  const mgr = await f.add("f-mgr", "manager", [domains[0]]);
  await f.turn(a.cookie, "湿度问题", { domain: domains[0] });
  await f.turn(b.cookie, "温度问题", { domain: domains[1] });

  const byQ = (
    await f.request(
      "/conversations?scope=team&q=" + encodeURIComponent("湿度"),
      undefined,
      mgr.cookie,
    )
  ).data;
  assert.equal(byQ.total, 1);
  assert.equal(byQ.stats.turns, 1);

  const byDept = (
    await f.request(
      "/conversations?scope=team&dept=" + encodeURIComponent(domains[1]),
      undefined,
      mgr.cookie,
    )
  ).data;
  assert.equal(byDept.total, 0, "部门管理员不能筛出其他部门");

  const byOwner = (
    await f.request(
      "/conversations?scope=team&owner=" + b.user.id,
      undefined,
      mgr.cookie,
    )
  ).data;
  assert.equal(byOwner.total, 0);

  const all = (
    await f.request("/conversations?scope=team&page=1&pageSize=20", undefined, f.admin)
  ).data;
  assert.ok(all.total >= 2);
  assert.ok(all.stats.people >= 2);
  assert.ok(all.stats.turns >= 2);
});

test("团队提问：总管理可看全部部门", async (t) => {
  const f = await fixture(t);
  const a = await f.add("team-a2", "employee", [domains[0]]);
  const b = await f.add("team-b2", "employee", [domains[1]]);
  await f.request(
    "/users",
    {
      username: "team-gm",
      password: "test-password-123",
      name: "总管理",
      role: "manager",
      dept_ids: [],
      scope_all: true,
      active: true,
    },
    f.admin,
  );
  const login = await f.request("/auth/login", {
    username: "team-gm",
    password: "test-password-123",
  });
  const gm = { cookie: login.cookie, user: login.data.user };

  await f.turn(a.cookie, "问题一", { domain: domains[0] });
  await f.turn(b.cookie, "问题二", { domain: domains[1] });

  const convs = (
    await f.request("/conversations?scope=team", undefined, gm.cookie)
  ).data.items;
  const names = convs.map((c) => c.title);
  assert.ok(names.includes("问题一"));
  assert.ok(names.includes("问题二"));
});
