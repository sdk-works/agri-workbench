import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { openRepository } from "./repository.mjs";
import { createWorkspace } from "./workspace.mjs";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agri-dom-")),
    repo = await openRepository({ filename: path.join(dir, "workspace.sqlite") });
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
      headers: { "Content-Type": "application/json", "X-Workbench": "1", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
  try {
    await request("/auth/setup", { username: "admin", password: "test-password-123", name: "管理" });
    const login = await request("/auth/login", { username: "admin", password: "test-password-123" });
    assert.equal(login.status, 200, "admin 登录");
    const admin = login.data.user && login.cookie ? "" : "";
    // need cookie: refetch login capturing set-cookie
    const lres = await fetch(base + "/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Workbench": "1" },
      body: JSON.stringify({ username: "admin", password: "test-password-123" }),
    });
    const cookie = lres.headers.get("set-cookie")?.split(";")[0];
    async function authReq(route, body, method) {
      return request(route, body, cookie, method);
    }
    // 1) 问题领域=active 部门名
    const deps = await authReq("/departments");
    assert.equal(deps.status, 200);
    const names = deps.data.items.map((d) => d.name);
    for (const n of ["种植管理", "农业物联网", "农业销售", "设计", "车间管理", "车间制造"])
      assert.ok(names.includes(n), "部门列表应含 " + n);
    console.log("PASS 1 领域=active部门名:", names.join(" / "));

    // 2) 员工保存 dept_ids 同步 domains
    const e = await authReq("/users", { username: "shop01", name: "车间员工", password: "test-password-123", role: "expert", dept_ids: ["dep-shop", "dep-manufacturing"], active: true });
    assert.equal(e.status, 201, JSON.stringify(e.data));
    assert.ok(e.data.user.domains.includes("车间管理"), "domains 含车间管理");
    assert.ok(e.data.user.domains.includes("车间制造"), "domains 含车间制造");
    console.log("PASS 2 员工domains同步:", e.data.user.domains.join(" / "));

    // 3) 上传资料可选新部门领域
    const b64 = Buffer.from("车间管理制度示例文本").toString("base64");
    const up = await authReq("/documents", { name: "车间制度.txt", domain: "车间管理", base64: b64, source: "自建", tags: "" });
    assert.ok([200, 202].includes(up.status), "上传车间领域应通过: " + JSON.stringify(up.data));
    assert.equal(up.data.document.domain, "车间管理");
    console.log("PASS 3 上传资料可选 车间管理 领域");

    // 4) 问答接受新部门领域
    const t = await authReq("/turns", { request_id: "req-0001", domain: "车间制造", question: "如何排产" });
    assert.ok([200, 202].includes(t.status), "问答车间领域: " + JSON.stringify(t.data));
    console.log("PASS 4 问答接受 车间制造 领域");

    console.log("ALL DOMAIN-SYNC PROBES PASSED");
  } finally {
    await ws.stop();
    await new Promise((r) => server.close(r));
    await repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main();
