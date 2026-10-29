import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { openRepository } from "./repository.mjs";
import { createWorkspace, domains } from "./workspace.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agri-dept-")),
    repoPromise = openRepository({ filename: path.join(dir, "workspace.sqlite") });
  return { dir, repoPromise };
}
async function run() {
  const { dir, repoPromise } = setup();
  const repo = await repoPromise;
  const gateway = {
    publicConfig: () => ({}),
    fallbackEnabled: () => false,
    judge: async () => ({}),
    call: async () => ({ answer: "x" }),
  };
  const json = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const readBody = async (req) => {
    const c = [];
    for await (const x of req) c.push(x);
    return JSON.parse(Buffer.concat(c).toString());
  };
  const ws = createWorkspace({ repo, gateway, uploadDir: path.join(dir, "u"), json, readBody });
  const server = http.createServer(async (req, res) => {
    try {
      if (!(await ws.handle(req, res, new URL(req.url, "http://localhost"))))
        json(res, 404, { error: "missing" });
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/v2`;
  async function request(route, body, cookie = "", method) {
    const res = await fetch(base + route, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        "X-Workbench": "1",
        Cookie: cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { status: res.status, data, cookie: res.headers.get("set-cookie")?.split(";")[0] };
  }
  await request("/auth/setup", { username: "admin", password: "test-password-123", name: "管理" });
  const login = await request("/auth/login", { username: "admin", password: "test-password-123" });
  const admin = login.cookie;
  async function loginUser(username) {
    const r = await request("/auth/login", { username, password: "test-password-123" });
    assert.equal(r.status, 200, "登录失败 " + username);
    return r;
  }
  return { request, admin, loginUser, ws, server, repo, dir };
}

test("部门体系：种子/增删停用/引用保护/多部门/条目权限", async (t) => {
  const { request, admin, loginUser, ws, server, repo, dir } = await run();
  t.after(async () => {
    await ws.stop();
    await new Promise((r) => server.close(r));
    await repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 1) 种子 6 部门
  const deps = await request("/departments", undefined, admin);
  assert.equal(deps.status, 200);
  const ids = deps.data.items.map((d) => d.id);
  for (const id of ["dep-planting", "dep-iot", "dep-sales", "dep-design", "dep-shop", "dep-manufacturing"])
    assert.ok(ids.includes(id), "缺少种子部门 " + id);

  // 2) 新增部门
  const added = await request("/departments", { name: "仓储物流" }, admin);
  assert.equal(added.status, 201, "新增部门应 201");
  const newId = added.data.id;

  // 3) 编辑部门（改名，ID 稳定）
  const renamed = await request("/departments", { id: newId, name: "仓储与物流" }, admin, "PUT");
  assert.equal(renamed.status, 200);

  // 4) 停用部门
  const off = await request("/departments", { id: newId, active: false }, admin, "PUT");
  assert.equal(off.status, 200);

  // 5) 删除无引用的停用部门
  const del = await request("/departments", { id: newId }, admin, "DELETE");
  assert.equal(del.status, 200, "无引用部门应可删除");

  // 6) 引用保护：删除被员工引用的部门应 409
  //    先建员工，dept_ids 含 dep-planting
  const e1 = await request(
    "/users",
    { username: "plant1", password: "test-password-123", name: "种植员", role: "employee", dept_ids: ["dep-planting"] },
    admin,
  );
  assert.equal(e1.status, 201, "多部门员工保存应 201");
  const delRef = await request("/departments", { id: "dep-planting" }, admin, "DELETE");
  assert.equal(delRef.status, 409, "被员工引用部门应拒绝删除");

  // 7) 引用保护：被条目引用的部门应 409
  await request(
    "/entries",
    { dept_id: "dep-shop", name: "车间A", code: "S-01", status: "运行中", owner: "李工", note: "主装配线" },
    admin,
  );
  const delEntryRef = await request("/departments", { id: "dep-shop" }, admin, "DELETE");
  assert.equal(delEntryRef.status, 409, "被条目引用部门应拒绝删除");

  // 8) 老员工迁移：以旧 domains 创建，自动推导 dept_ids
  const legacy = await request(
    "/users",
    { username: "old1", password: "test-password-123", name: "老员工", role: "employee", domains: ["种植管理", "农业销售"] },
    admin,
  );
  assert.equal(legacy.status, 201);
  const legacyLogin = await loginUser("old1");
  assert.deepEqual(legacyLogin.data.user.dept_ids.slice().sort(), ["dep-planting", "dep-sales"].sort(), "老领域应迁移为部门");

  // 9) 多部门员工：登录后 dept_ids 正确
  const e1Login = await loginUser("plant1");
  assert.deepEqual(e1Login.data.user.dept_ids, ["dep-planting"]);

  // 10) 条目权限：管理员新增 → 属于该部门员工可看 → 跨部门 403 → 无部门 403
  const shopUser = await request(
    "/users",
    { username: "shop1", password: "test-password-123", name: "车间员", role: "employee", dept_ids: ["dep-shop"] },
    admin,
  );
  const crossUser = await request(
    "/users",
    { username: "cross1", password: "test-password-123", name: "跨部门", role: "employee", dept_ids: ["dep-planting"] },
    admin,
  );
  const noneUser = await request(
    "/users",
    { username: "none1", password: "test-password-123", name: "无部门", role: "employee", dept_ids: [] },
    admin,
  );
  const shopLogin = await loginUser("shop1");
  const crossLogin = await loginUser("cross1");
  const noneLogin = await loginUser("none1");

  // 属于 dep-shop 员工可看
  const shopView = await request("/entries?dept=dep-shop", undefined, shopLogin.cookie);
  assert.equal(shopView.status, 200, "部门员工应能查看条目");
  assert.ok(shopView.data.items.some((e) => e.name === "车间A"), "应看到管理员新增的条目");

  // 跨部门（dep-planting）员工看 dep-shop → 403
  const crossView = await request("/entries?dept=dep-shop", undefined, crossLogin.cookie);
  assert.equal(crossView.status, 403, "跨部门员工无权查看别的部门条目");

  // 无部门员工 → 403
  const noneView = await request("/entries?dept=dep-shop", undefined, noneLogin.cookie);
  assert.equal(noneView.status, 403, "无部门员工无权查看");

  // 部门员工无权新增条目（管理员维护）
  const shopAdd = await request("/entries", { dept_id: "dep-shop", name: "私加" }, shopLogin.cookie);
  assert.equal(shopAdd.status, 403, "部门员工不能维护条目（管理员才可）");

  // admin 维护：编辑 + 删除条目
  const shopEntry = shopView.data.items.find((e) => e.name === "车间A");
  const edit = await request(
    "/entries",
    { id: shopEntry.id, dept_id: "dep-shop", name: "车间A", code: "S-01", status: "停机", owner: "李工", note: "保养" },
    admin,
    "PUT",
  );
  assert.equal(edit.status, 200, "管理员应能编辑条目");
  const delEntry = await request("/entries", { id: shopEntry.id }, admin, "DELETE");
  assert.equal(delEntry.status, 200, "管理员应能删除条目");

  // 11) 停用后员工不能看该部门条目（导航/后端都不出现）
  await request("/departments", { id: "dep-shop", active: false }, admin, "PUT");
  const stoppedView = await request("/entries?dept=dep-shop", undefined, shopLogin.cookie);
  assert.equal(stoppedView.status, 403, "停用部门员工无权访问");
});
