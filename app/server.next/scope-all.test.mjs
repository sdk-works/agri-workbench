import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

async function login(f, username) {
  const res = await f.request("/auth/login", {
    username,
    password: "test-password-123",
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return { cookie: res.cookie, user: res.data.user };
}

test("总管理：覆盖后来新增的部门", async (t) => {
  const f = await fixture(t);
  const created = await f.request(
    "/users",
    {
      username: "gm-all",
      password: "test-password-123",
      name: "总管理",
      role: "manager",
      dept_ids: [],
      scope_all: true,
      active: true,
    },
    f.admin,
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.scope_all, true);
  const gm = await login(f, "gm-all");

  // 之后新增部门
  const dept = await f.request("/departments", { name: "新增部门" }, f.admin);
  assert.equal(dept.status, 201);
  const name = dept.data.name;

  // 新部门资料：总管理可见
  const doc = await f.request(
    "/documents",
    {
      name: "new.txt",
      domain: name,
      base64: Buffer.from("新部门资料", "utf8").toString("base64"),
      source: "测试",
      tags: "",
    },
    f.admin,
  );
  assert.equal(doc.status, 202, JSON.stringify(doc.data));
  assert.equal(
    (await f.request(`/documents/${doc.data.document.id}`, undefined, gm.cookie))
      .status,
    200,
    "总管理应能看到新增部门的资料",
  );

  // 新部门提问：允许
  assert.equal(
    (
      await f.request(
        "/turns",
        { request_id: randomUUID(), question: "新部门问题", domain: name },
        gm.cookie,
      )
    ).status,
    202,
  );
});

test("部门管理员不能借编辑把员工踢出其他部门", async (t) => {
  const f = await fixture(t);
  const depts = (await f.request("/departments", undefined, f.admin)).data.items;
  const d0 = depts.find((d) => d.name === domains[0]);
  const d1 = depts.find((d) => d.name === domains[1]);

  await f.request(
    "/users",
    {
      username: "mgr0",
      password: "test-password-123",
      name: "部门管理",
      role: "manager",
      dept_ids: [d0.id],
      active: true,
    },
    f.admin,
  );
  const mgr = await login(f, "mgr0");

  const staff = await f.request(
    "/users",
    {
      username: "staff2",
      password: "test-password-123",
      name: "双部门员工",
      role: "employee",
      dept_ids: [d0.id, d1.id],
      active: true,
    },
    f.admin,
  );
  assert.equal(staff.status, 201);

  const edit = await f.request(
    "/users",
    {
      id: staff.data.user.id,
      username: "staff2",
      name: "双部门员工",
      role: "employee",
      dept_ids: [d0.id],
      active: true,
    },
    mgr.cookie,
  );
  assert.equal(edit.status, 403, JSON.stringify(edit.data));
  assert.match(edit.data.error, /其他部门/);
});

test("停用/删除部门：有资料或问答即拒绝", async (t) => {
  const f = await fixture(t);
  const dept = await f.request("/departments", { name: "空置部门" }, f.admin);
  assert.equal(dept.status, 201);
  const id = dept.data.id;
  const name = dept.data.name;

  const doc = await f.request(
    "/documents",
    {
      name: "a.txt",
      domain: name,
      base64: Buffer.from("资料", "utf8").toString("base64"),
      source: "测试",
      tags: "",
    },
    f.admin,
  );
  assert.equal(doc.status, 202);

  const disable = await f.request(
    "/departments",
    { id, active: false },
    f.admin,
    "PUT",
  );
  assert.equal(disable.status, 409, "有资料的部门不能停用");

  const del = await f.request("/departments", { id }, f.admin, "DELETE");
  assert.equal(del.status, 409, "有资料的部门不能删除");
});

test("总管理即使角色是专家，也能看团队提问与员工", async (t) => {
  const f = await fixture(t);
  const depts = (await f.request("/departments", undefined, f.admin)).data.items;
  const d0 = depts.find((d) => d.name === domains[0]);
  const d1 = depts.find((d) => d.name === domains[1]);

  await f.request(
    "/users",
    {
      username: "gm-expert",
      password: "test-password-123",
      name: "总管理专家",
      role: "expert",
      dept_ids: [d0.id],
      scope_all: true,
      active: true,
    },
    f.admin,
  );
  const gm = await login(f, "gm-expert");

  const staff = await f.add("staff-d1", "employee", [domains[1]]);
  await f.turn(staff.cookie, "物联网部门的问题", { domain: domains[1] });

  const convs = await f.request(
    "/conversations?scope=team",
    undefined,
    gm.cookie,
  );
  assert.equal(convs.status, 200, JSON.stringify(convs.data));
  assert.ok(convs.data.items.length >= 1, "总管理应看到其他部门的会话");

  const users = await f.request("/users", undefined, gm.cookie);
  assert.equal(users.status, 200);
  assert.ok(users.data.items.some((u) => u.username === "staff-d1"));
});
