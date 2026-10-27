// 图片任务状态对账：列表接口必须与 ComfyUI 同步，否则任务永久 "排队中"
// 复现依据：2026-10-23 14:04 ComfyUI 6.08s 出图完成、队列为空，平台任务仍为 queued；
//          前端只轮询 GET /api/v2/images/tasks（列表），而列表原先不调用 syncTask。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createImageServer } from "./image-server.mjs";

const TOKEN = "test-token-abc";
const USER = { id: "u-1", active: true, username: "e2e_agent", tenant: "park" };

function memRepo(initial) {
  const db = new Map();
  for (const [col, rows] of Object.entries(initial)) {
    for (const [id, v] of Object.entries(rows)) db.set(`${col}:${id}`, v);
  }
  return {
    db,
    async get(col, id) {
      if (col === "sessions") return { owner: USER.id, expires_at: Date.now() + 3600_000 };
      if (col === "users") return USER;
      return db.get(`${col}:${id}`) || null;
    },
    async put(col, v) {
      db.set(`${col}:${v.id}`, v);
      return v;
    },
    async list(col, q) {
      return [...db.entries()]
        .filter(([k]) => k.startsWith(col + ":"))
        .map(([, v]) => v)
        .filter((v) => (q && q.owner ? v.owner === q.owner : true));
    },
  };
}

// 假 ComfyUI：/history/<pid> 返回指定历史
function fakeComfy(historyByPid) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    const m = String(req.url).match(/^\/history\/(.+)$/);
    const h = m ? historyByPid[m[1]] : null;
    // 真实 ComfyUI 返回 { "<prompt_id>": { status, outputs } }
    const body = m ? (h ? { [m[1]]: h } : {}) : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, hits }));
  });
}

function makeServer(repo, comfyPort, outDir) {
  let captured = null;
  const server = createImageServer({
    repo,
    env: { IMAGE_COMFY_URL: `http://127.0.0.1:${comfyPort}`, IMAGE_OUTPUT_DIR: outDir },
    json: (res, status, v) => { captured = { status, v }; },
    readBody: async () => ({}),
  });
  const call = async (p) => {
    captured = null;
    const req = { method: "GET", headers: { cookie: `agri_session=${TOKEN}`, "x-workbench": "1" } };
    const url = new URL("http://x" + p);
    await server.handle(req, { writeHead() {}, end() {} }, url);
    return captured;
  };
  return { call };
}

const job = (over) => ({
  id: "j-1", owner: USER.id, user_id: USER.id, tenant: "park", domain: "image",
  prompt: "温室", width: 1024, height: 1024, seed: 1, status: "queued",
  created_at: new Date().toISOString(), comfy_prompt_id: "p-1", filename: "", error: "",
  completed_at: "", ...over,
});

test("列表接口把 ComfyUI 已完成的任务回写为 completed（修复永久排队）", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
  const { srv, port, hits } = await fakeComfy({
    "p-1": { status: { completed: true, status_str: "success" }, outputs: { "9": { images: [{ subfolder: "qhe", filename: "qhe_0001.png" }] } } },
  });
  t.after(() => srv.close());

  const repo = memRepo({ image_jobs: { "j-1": job() } });
  const { call } = makeServer(repo, port, outDir);

  const r = await call("/api/v2/images/tasks");
  assert.equal(r.status, 200);
  assert.equal(r.v.items.length, 1);
  assert.equal(r.v.items[0].status, "completed", "列表必须已完成对账");
  assert.equal(r.v.items[0].filename, "qhe/qhe_0001.png");
  assert.ok(hits.some((h) => h === "/history/p-1"), "应查询 ComfyUI history");

  const saved = repo.db.get("image_jobs:j-1");
  assert.equal(saved.status, "completed", "必须回写数据库，避免下次又变回 queued");
});

test("ComfyUI 丢失任务时，超时任务被判失败而不是永久排队", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
  const { srv, port } = await fakeComfy({}); // 没有任何 history
  t.after(() => srv.close());

  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 分钟前
  const repo = memRepo({ image_jobs: { "j-1": job({ created_at: old }) } });
  const { call } = makeServer(repo, port, outDir);

  const r = await call("/api/v2/images/tasks");
  assert.equal(r.v.items[0].status, "failed");
  assert.match(r.v.items[0].error, /出图超时/);
});

test("未超时且 ComfyUI 仍在排队时保持 queued/running，不误判失败", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
  const { srv, port } = await fakeComfy({});
  t.after(() => srv.close());

  const repo = memRepo({ image_jobs: { "j-1": job() } }); // 刚创建
  const { call } = makeServer(repo, port, outDir);

  const r = await call("/api/v2/images/tasks");
  assert.notEqual(r.v.items[0].status, "failed");
});

test("已完成的任务不再重复查询 ComfyUI（避免无谓开销）", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
  const { srv, port, hits } = await fakeComfy({});
  t.after(() => srv.close());

  const repo = memRepo({ image_jobs: { "j-1": job({ status: "completed", filename: "a/b.png" }) } });
  const { call } = makeServer(repo, port, outDir);
  const r = await call("/api/v2/images/tasks");
  assert.equal(r.v.items[0].status, "completed");
  assert.equal(hits.length, 0, "终端态任务不应再查 ComfyUI");
});
