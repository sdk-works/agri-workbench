import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { openRepository } from "./repository.mjs";
import { createGateway } from "./model-gateway.mjs";
import { createWorkspace } from "./workspace.mjs";
import { loadEnv } from "./env.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  env = loadEnv();
const port = Number(env.PORT || 8787);
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}
async function readBody(req, limit = 12_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(Error("请求过大"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(Error("JSON 格式无效"), { status: 400 });
  }
}
const legacyPath = env.DATA_PATH || path.join(root, "data/workbench.sqlite");
const legacyStore = fs.existsSync(legacyPath) ? new Store(legacyPath) : null;
const repo = await openRepository({
  filename: env.WORKSPACE_DATA_PATH || path.join(root, "data/workspace.sqlite"),
  databaseUrl: env.DATABASE_URL,
});
const gateway = createGateway(
  env,
  env.MODEL_CONFIG_PATH || path.join(root, "data/model-config.json"),
);
const workspace = createWorkspace({
  repo,
  gateway,
  uploadDir: env.UPLOAD_PATH || path.join(root, "uploads"),
  json,
  readBody,
  legacyStore,
  secureCookies: env.COOKIE_SECURE === "true",
});
await workspace.start();
const allowedOrigins = new Set(
  (
    env.ALLOWED_ORIGINS ||
    "http://127.0.0.1:5174,http://localhost:5174,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8787,http://localhost:8787"
  )
    .split(",")
    .map((s) => s.trim()),
);
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
      return json(res, 403, { error: "页面来源未授权" });
    if (
      req.method === "POST" &&
      !String(req.headers["content-type"] || "").startsWith("application/json")
    )
      return json(res, 415, { error: "需要 application/json" });
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/v1/health")
      return json(res, 200, { ok: true, version: "0.3.0", storage: repo.type });
    if (await workspace.handle(req, res, url)) return;
    if (url.pathname.startsWith("/api/v1/"))
      return json(res, 410, {
        error:
          "旧版接口已停用，请使用新版工作台；旧记录由管理员在模型与规则页查看",
      });
    json(res, 404, { error: "接口不存在" });
  } catch (e) {
    if (!res.headersSent)
      json(res, e.status || 500, {
        error: e.status ? e.message : "服务处理失败，请重试或联系管理员",
      });
    else res.end();
  }
});
server.requestTimeout = 60000;
server.listen(port, "127.0.0.1", () =>
  console.log(`农业工作台 v0.3: http://127.0.0.1:${port} · ${repo.type}`),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await workspace.stop();
  await repo.close();
  legacyStore?.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
