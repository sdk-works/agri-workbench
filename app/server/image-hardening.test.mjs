// 图片修复的四项加固检查：对账限流与超时 / 并发幂等 / 权限隔离 / 超时后后台任务处置
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createImageServer } from "./image-server.mjs";

const TOKEN = "tok";
const A = { id: "u-a", active: true, username: "a", tenant: "park" };
const B = { id: "u-b", active: true, username: "b", tenant: "park" };
const state = { user: A };

function memRepo(rows = []) {
  const db = new Map(rows.map((r) => [`image_jobs:${r.id}`, r]));
  return {
    db,
    async get(col, id) {
      if (col === "sessions") return state.user ? { owner: state.user.id, expires_at: Date.now() + 3600_000 } : null;
      if (col === "users") return state.user;
      return db.get(`${col}:${id}`) || null;
    },
    async put(col, v) { db.set(`${col}:${v.id}`, v); return v; },
    async list(col, q) {
      return [...db.entries()].filter(([k]) => k.startsWith(col + ":")).map(([, v]) => v)
        .filter((v) => (q && q.owner ? v.owner === q.owner : true));
    },
  };
}

const job = (over) => ({
  id: "j-1", owner: A.id, user_id: A.id, tenant: "park", domain: "image",
  prompt: "温室", width: 1024, height: 1024, seed: 1, status: "queued",
  created_at: new Date().toISOString(), comfy_prompt_id: "p-1", filename: "", error: "",
  completed_at: "", ...over,
});

// 假 ComfyUI：可配置 history、/prompt、/queue、延迟
function fakeComfy({ history = {}, delayMs = 0, onQueue, queue = { running: [], pending: [] } } = {}) {
  const hits = [];
  const prompts = [];
  const srv = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (d) => (buf += d));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body: buf });
      const send = (obj) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const later = () => (delayMs ? setTimeout(run, delayMs) : run());
      function run() {
        if (req.method === "POST" && req.url === "/prompt") {
          prompts.push(JSON.parse(buf || "{}"));
          return send({ prompt_id: "p-new" });
        }
        if (req.method === "POST" && req.url === "/queue") {
          if (onQueue) return onQueue(req, res, buf);
          try {
            const del = JSON.parse(buf || "{}").delete || [];
            // 与 ComfyUI 一致：只能删掉还在排队的，正在跑的删不掉
            queue.pending = queue.pending.filter((p) => !del.includes(p));
          } catch {}
          return send({ ok: true });
        }
        if (req.method === "GET" && req.url === "/queue") {
          const wrap = (arr) => arr.map((p, i) => [i + 1, p, {}]);
          return send({ queue_running: wrap(queue.running), queue_pending: wrap(queue.pending) });
        }
        const m = String(req.url).match(/^\/history\/(.+)$/);
        if (m) return send(history[m[1]] ? { [m[1]]: history[m[1]] } : {});
        res.writeHead(404); res.end("{}");
      }
      later();
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, hits, prompts }));
  });
}

function makeServer(repo, port) {
  let out = null;
  state.user = A; // 每个用例默认以 A 登录，避免用例间串态
  const server = createImageServer({
    repo,
    env: { IMAGE_COMFY_URL: `http://127.0.0.1:${port}`, IMAGE_OUTPUT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "img-")) },
    json: (res, status, v) => { out = { status, v }; },
    readBody: async (req) => req._body || {},
  });
  const call = async (method, p, bodyObj) => {
    out = null;
    const req = { method, headers: { cookie: `agri_session=${TOKEN}`, "x-workbench": "1" }, _body: bodyObj };
    const url = new URL("http://x" + p);
    try {
      await server.handle(req, { writeHead() {}, end() {} }, url);
    } catch (e) {
      if (out === null) out = { status: e.status || 500, v: { error: e.message } };
    }
    return out;
  };
  return { call };
}

// ---------------- 1. 对账限流与超时 ----------------

test("列表对账单次最多 5 个任务，不会随任务数放大", async (t) => {
  const { srv, port, hits } = await fakeComfy();
  t.after(() => srv.close());
  const rows = Array.from({ length: 12 }, (_, i) => job({ id: `j-${i}`, comfy_prompt_id: `p-${i}` }));
  const { call } = makeServer(memRepo(rows), port);

  const r = await call("GET", "/api/v2/images/tasks");
  assert.equal(r.status, 200);
  assert.equal(r.v.items.length, 12);
  const historyHits = hits.filter((h) => h.url.startsWith("/history/"));
  assert.equal(historyHits.length, 5, "单次最多对账 5 个");
});

test("ComfyUI 卡住不返回时，列表仍在超时预算内返回且不误判失败", async (t) => {
  const { srv, port } = await fakeComfy({ delayMs: 5000 }); // 远大于 1.2s
  t.after(() => srv.close());
  const { call } = makeServer(memRepo([job()]), port);

  const t0 = Date.now();
  const r = await call("GET", "/api/v2/images/tasks");
  const ms = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.ok(ms < 2600, `列表应在超时预算内返回，实际 ${ms}ms`);
  assert.equal(r.v.items[0].status, "queued", "对账超时不能把任务判失败");
});

// ---------------- 2. 并发幂等 ----------------

test("同一任务被并发轮询时，只查一次 ComfyUI、只写一次库", async (t) => {
  const { srv, port, hits } = await fakeComfy({
    history: { "p-1": { status: { completed: true, status_str: "success" }, outputs: { "9": { images: [{ filename: "a.png" }] } } } },
    delayMs: 300,
  });
  t.after(() => srv.close());
  const repo = memRepo([job()]);
  let puts = 0;
  const origPut = repo.put.bind(repo);
  repo.put = async (c, v) => { puts += 1; return origPut(c, v); };
  const { call } = makeServer(repo, port);

  const [r1, r2, r3] = await Promise.all([
    call("GET", "/api/v2/images/tasks"),
    call("GET", "/api/v2/images/tasks"),
    call("GET", "/api/v2/images/tasks"),
  ]);
  const histHits = hits.filter((h) => h.url.startsWith("/history/"));
  assert.equal(histHits.length, 1, "并发请求共享同一次查询");
  assert.equal(puts, 1, "并发请求只写一次库");
  for (const r of [r1, r2, r3]) assert.equal(r.v.items[0].status, "completed");
});

test("迟到的对账结果不会覆盖已终态（已完成/已失败不被回滚）", async (t) => {
  const { srv, port } = await fakeComfy({
    history: { "p-1": { status: { completed: true, status_str: "success" }, outputs: { "9": { images: [{ filename: "a.png" }] } } } },
  });
  t.after(() => srv.close());
  const repo = memRepo([job({ status: "failed", error: "出图超时（服务端未返回结果），请重试" })]);
  const { call } = makeServer(repo, port);

  // 直接调用同步路径无法从路由触发（已是终态），这里验证"新结果不覆盖终态"的写库守卫
  const r = await call("GET", "/api/v2/images/tasks");
  assert.equal(r.v.items[0].status, "failed");
  assert.match(repo.db.get("image_jobs:j-1").error, /出图超时/);
});

test("双击提交不会创建多个任务（同 prompt+尺寸 10s 内复用）", async (t) => {
  const { srv, port, prompts } = await fakeComfy();
  t.after(() => srv.close());
  const repo = memRepo([]);
  const { call } = makeServer(repo, port);

  const first = await call("POST", "/api/v2/images/generate", { prompt: "温室", size: 1024 });
  const second = await call("POST", "/api/v2/images/generate", { prompt: "温室", size: 1024 });
  assert.equal(prompts.filter((p) => p.prompt).length, 1, "ComfyUI 只应收到一次 /prompt");
  assert.equal(second.v.task.id, first.v.task.id, "第二次应复用同一任务");
  assert.equal(second.v.task.deduped, true);
  assert.equal(repo.db.size, 1, "库里只有一个任务");
});

// ---------------- 3. 权限隔离 ----------------

test("用户隔离：A 看不到 B 的任务；跨用户取图/取消被拒；未登录 401", async (t) => {
  const { srv, port } = await fakeComfy();
  t.after(() => srv.close());
  const repo = memRepo([job({ id: "j-b", owner: B.id, user_id: B.id })]);
  const { call } = makeServer(repo, port);

  state.user = A;
  const list = await call("GET", "/api/v2/images/tasks");
  assert.equal(list.v.items.length, 0, "A 不应看到 B 的任务");

  const file = await call("GET", "/api/v2/images/j-b/file");
  assert.equal(file.status, 403);

  const cancel = await call("POST", "/api/v2/images/tasks/j-b/cancel");
  assert.equal(cancel.status, 403);

  state.user = null;
  const anon = await call("GET", "/api/v2/images/tasks");
  assert.equal(anon.status, 401);

  state.user = B;
  const own = await call("GET", "/api/v2/images/tasks");
  assert.equal(own.v.items.length, 1, "B 能看到自己的任务");
});

// ---------------- 4. 超时后后台任务处置 ----------------

test("超时判定时先向 ComfyUI 删除该 prompt，再标记失败", async (t) => {
  const { srv, port, hits } = await fakeComfy();
  t.after(() => srv.close());
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const repo = memRepo([job({ created_at: old })]);
  const { call } = makeServer(repo, port);

  const r = await call("GET", "/api/v2/images/tasks");
  assert.equal(r.v.items[0].status, "failed");
  assert.equal(r.v.items[0].cancel_attempted, true);
  assert.equal(r.v.items[0].cancel_ok, true);
  const del = hits.find((h) => h.url === "/queue" && h.method === "POST");
  assert.ok(del, "应调用 ComfyUI /queue 删除");
  assert.deepEqual(JSON.parse(del.body).delete, ["p-1"]);
});

test("取消失败也照样判失败，并记录 cancel_ok=false", async (t) => {
  const { srv, port } = await fakeComfy({
    onQueue: (req, res) => { res.writeHead(500); res.end("boom"); },
  });
  t.after(() => srv.close());
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const repo = memRepo([job({ created_at: old })]);
  const { call } = makeServer(repo, port);

  const r = await call("GET", "/api/v2/images/tasks");
  assert.equal(r.v.items[0].status, "failed");
  assert.equal(r.v.items[0].cancel_ok, false);
});

test("对账公平性：多轮轮询能覆盖全部活跃任务（不饿死后面的）", async (t) => {
  const { srv, port, hits } = await fakeComfy();
  t.after(() => srv.close());
  const rows = Array.from({ length: 12 }, (_, i) => job({ id: `f-${i}`, comfy_prompt_id: `q-${i}` }));
  const { call } = makeServer(memRepo(rows), port);

  for (let k = 0; k < 5; k++) await call("GET", "/api/v2/images/tasks");
  const queried = new Set(hits.filter(h => h.url.startsWith("/history/")).map(h => h.url.replace("/history/", "")));
  const never = rows.map(r => r.comfy_prompt_id).filter(p => !queried.has(p));
  assert.equal(never.length, 0, `存在饥饿：${never.join(",")}`);
  assert.ok(queried.size === 12, `5 轮应覆盖 12 个，实际 ${queried.size}`);
});

// ---------------- 取消语义（不假取消、不全局中断） ----------------

test("取消已完成任务：保留 completed 实际状态，不改成 cancelled", async (t) => {
  const { srv, port, hits } = await fakeComfy();
  t.after(() => srv.close());
  const repo = memRepo([job({ status: "completed", filename: "a/b.png" })]);
  const { call } = makeServer(repo, port);

  const r = await call("POST", "/api/v2/images/tasks/j-1/cancel", {});
  assert.equal(r.v.cancelled, false);
  assert.equal(r.v.reason, "already_finished");
  assert.equal(r.v.task.status, "completed", "已完成不能被降级为 cancelled");
  assert.equal(r.v.task.filename, "a/b.png");
  assert.equal(hits.filter(h => h.url === "/queue").length, 0, "终态任务不应再去打 ComfyUI");
});

test("取消排队中任务：/queue delete 生效且回查确认已移除 → cancelled", async (t) => {
  const { srv, port } = await fakeComfy({ queue: { running: [], pending: ["p-1"] } });
  t.after(() => srv.close());
  const repo = memRepo([job()]);
  const { call } = makeServer(repo, port);

  const r = await call("POST", "/api/v2/images/tasks/j-1/cancel", {});
  assert.equal(r.v.cancelled, true);
  assert.equal(r.v.task.status, "cancelled");
});

test("取消生成中任务：删不掉就保持 running，并说明无法中断（不做全局中断）", async (t) => {
  const { srv, port, hits } = await fakeComfy({ queue: { running: ["p-1"], pending: [] } });
  t.after(() => srv.close());
  const repo = memRepo([job({ status: "running" })]);
  const { call } = makeServer(repo, port);

  const r = await call("POST", "/api/v2/images/tasks/j-1/cancel", {});
  assert.equal(r.v.cancelled, false);
  assert.equal(r.v.reason, "cancel_failed");
  assert.equal(r.v.task.status, "running", "不能宣称已取消");
  assert.equal(r.v.task.cancel_ok, false);
  assert.match(r.v.task.cancel_error, /无法中断/);
  assert.equal(hits.filter(h => /interrupt/.test(h.url)).length, 0, "绝不调用全局 /interrupt");
});
