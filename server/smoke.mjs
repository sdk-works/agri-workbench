// Real HTTP server, isolated storage, no model calls or production data writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { digest } from "./documents.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agri-smoke-"));
const reservation = net.createServer();
await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const base = `http://127.0.0.1:${port}`;
let child,
  logs = "",
  cookie = "";
const delay = () => new Promise((r) => setTimeout(r, 150));
async function poll(fn) {
  for (let i = 0; i < 160; i++) {
    const value = await fn();
    if (value) return value;
    await delay();
  }
  throw Error("Smoke test timed out");
}
async function request(route, body, expected = 200) {
  const res = await fetch(base + "/api/v2" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Workbench": "1",
      Cookie: cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  assert.equal(res.status, expected, JSON.stringify(data));
  if (res.headers.get("set-cookie"))
    cookie = res.headers.get("set-cookie").split(";")[0];
  return data;
}
try {
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    {
      windowsHide: true,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: "",
        DATA_PATH: path.join(dir, "missing.sqlite"),
        WORKSPACE_DATA_PATH: path.join(dir, "workspace.sqlite"),
        MODEL_CONFIG_PATH: path.join(dir, "models.json"),
        UPLOAD_PATH: path.join(dir, "uploads"),
        COOKIE_SECURE: "false",
        ALLOWED_ORIGINS: base,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (x) => (logs += x));
  child.stderr.on("data", (x) => (logs += x));
  await poll(async () => {
    try {
      return (await fetch(base + "/api/v1/health")).ok;
    } catch {
      return false;
    }
  });
  await request("/capabilities", undefined, 401);
  assert.equal(
    (
      await fetch(base + "/api/v2/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/v1/health", {
        headers: { Origin: "https://untrusted.invalid" },
      })
    ).status,
    403,
  );
  const credentials = { username: "smoke-admin", password: randomUUID() };
  await request("/auth/setup", { ...credentials, name: "Smoke" }, 201);
  await request("/auth/login", credentials);
  assert.equal((await request("/capabilities")).training.configured, false);
  const content = "番茄巡检需核对传感器单位、时间和生育期。";
  const imported = await request(
    "/imports",
    {
      request_id: randomUUID(),
      items: [{ name: "smoke.txt", domain: "种植管理" }],
    },
    201,
  );
  await request(
    `/imports/${imported.id}/items/${imported.items[0].id}`,
    { base64: Buffer.from(content).toString("base64") },
    202,
  );
  const batch = await request(`/imports/${imported.id}`);
  const id = batch.items[0].document_id;
  const document = await poll(async () => {
    const d = await request(`/documents/${id}`);
    return d.status === "pending" && d;
  });
  const published = await request(`/documents/${id}/publish`, {
    revision: document.revision,
    text: content,
    checked: true,
    evidence: "模拟资料核验",
  });
  const annotation = await request(`/documents/${id}/annotation`, {
    revision: 0,
    document_revision: published.revision,
    fields: { title: "番茄巡检", crop: "番茄" },
  });
  await request(`/documents/${id}/annotation/approve`, {
    revision: annotation.revision,
    checked: true,
    evidence: "模拟标注核验",
  });
  const asset = await request(
    "/asset-exports",
    { request_id: randomUUID(), document_ids: [id], include_originals: true },
    202,
  );
  const completed = await poll(async () => {
    const a = await request(`/asset-exports/${asset.id}`);
    assert.notEqual(a.status, "failed", JSON.stringify(a));
    return a.status === "completed" && a;
  });
  const response = await fetch(
    base + `/api/v2/asset-exports/${asset.id}/download`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(digest(bytes), completed.sha256);
  const zip = await JSZip.loadAsync(bytes);
  const record = JSON.parse(
    await zip.file(`annotations/${id}.json`).async("string"),
  );
  assert.equal(record.content, content);
  assert(
    (await zip.file(`knowledge/${id}.md`).async("string")).includes(content),
  );
  for (const entry of JSON.parse(
    await zip.file("manifest.json").async("string"),
  ).files)
    assert.equal(
      digest(await zip.file(entry.path).async("nodebuffer")),
      entry.sha256,
    );
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "server startup",
        "authentication",
        "CSRF",
        "origin restriction",
        "batch upload",
        "background parsing",
        "expert publication",
        "annotation approval",
        "asset packaging",
        "download checksums",
        "MD/JSON consistency",
      ],
    }),
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (child && child.exitCode === null) {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
