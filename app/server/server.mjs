import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { openRepository } from "./repository.mjs";
import { createGateway } from "./model-gateway.mjs";
import { policyFromEnv } from "./policy.mjs";
import { createWorkspace } from "./workspace.mjs";
import { createImageServer } from "./image-server.mjs";
import { createVoice } from "./voice.mjs";
import { loadEnv } from "./env.mjs";
import { buildOriginMatcher } from "./origin-guard.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  env = loadEnv();
const port = Number(env.PORT || 8787);
// 构建指纹：前端构建时写 dist/build.json（commit + 构建时间），这里读出来对外暴露。
// 没有它的时候排障最常问的一句是"线上这版到底是哪个提交建的"——答不上来就只能猜。
const BOOT_AT = new Date().toISOString();
const BUILD_FILE = path.join(root, "dist", "build.json");
function readBuildStamp() {
  try {
    return JSON.parse(fs.readFileSync(BUILD_FILE, "utf8"));
  } catch {
    return { commit: "unknown", builtAt: "", note: "没有 dist/build.json，用 app/build.sh 重新构建" };
  }
}
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
  {
    limits: {
      localConcurrency: Number(env.LOCAL_CONCURRENCY || 2),
      cloudConcurrency: Number(env.CLOUD_CONCURRENCY || 2),
    },
    // 路由规则与采样参数：改 data/model-policy.json 即可，无需改代码
    policy: policyFromEnv(
      env,
      path.join(root, "..", "data", "model-policy.json"),
    ),
  },
);
const imageServer = createImageServer({ repo, env, json, readBody });
const workspace = createWorkspace({
  repo,
  gateway,
  uploadDir: env.UPLOAD_PATH || path.join(root, "uploads"),
  json,
  readBody,
  legacyStore,
  secureCookies: env.COOKIE_SECURE === "true",
  createImageTask: imageServer.createTask,
  limits: {
    activeGen: Number(env.ACTIVE_GEN_CONCURRENCY || 2),
    activePerUser: Number(env.ACTIVE_PER_USER || 1),
    queuedPerUser: Number(env.QUEUED_PER_USER || 1),
    localConcurrency: Number(env.LOCAL_CONCURRENCY || 2),
    cloudConcurrency: Number(env.CLOUD_CONCURRENCY || 2),
  },
});
await workspace.start();
const voice = createVoice({ env, json, readBody, gateway, workspace });
// 页面来源校验见 origin-guard.mjs（独立成模块是为了能单独测它）。
const originAllowed = buildOriginMatcher(
  env.ALLOWED_ORIGINS ||
    "http://127.0.0.1:5174,http://localhost:5174,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8787,http://localhost:8787",
);
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.origin && !originAllowed(req.headers.origin))
      return json(res, 403, { error: "页面来源未授权" });
    const url = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      !url.pathname.startsWith("/api/v2/voice/asr") &&
      !url.pathname.startsWith("/api/v2/voice/image") &&
      !String(req.headers["content-type"] || "").startsWith("application/json")
    )
      return json(res, 415, { error: "需要 application/json" });
    if (req.method === "GET" && url.pathname === "/api/v1/health")
      return json(res, 200, { ok: true, version: "0.4.0", storage: repo.type });
    // 版本指纹：前端、服务、提交三者能不能对上，看这一个地址就够了
    if (req.method === "GET" && url.pathname === "/api/v2/version")
      return json(res, 200, {
        ok: true,
        api: "0.4.0",
        ...readBuildStamp(),
        startedAt: BOOT_AT,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
      });
    if (await voice.handle(req, res, url)) return;
    if (await imageServer.handle(req, res, url)) return;
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
  console.log(`农业工作台 v0.4: http://127.0.0.1:${port} · ${repo.type}`),
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
