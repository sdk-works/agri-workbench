import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { openRepository } from "./repository.mjs";
import { createWorkspace, domains } from "./workspace.mjs";
import { createGateway } from "./model-gateway.mjs";
import { cleanParts, parseDocument } from "./documents.mjs";

export const result = () => ({
  winner: "A",
  score_a: 4,
  score_b: 4,
  reason: "结论相同",
  differences: [],
  conflicts: [],
  missing_conditions: [],
  material_difference: false,
  both_bad: false,
  evidence_status: "not_needed",
  model: "judge-independent",
  provider: "cloud",
  degraded: false,
});
export async function fixture(
  t,
  { judge = async () => result(), call: generate } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agri-v3-")),
    repo = await openRepository({
      filename: path.join(dir, "workspace.sqlite"),
    });
  const calls = [];
  const gateway = {
    publicConfig: () => ({
      local: { model: "local-model" },
      cloud: { model: "cloud-model" },
    }),
    fallbackEnabled: () => false,
    judge,
    call:
      generate ||
      (async (role, messages) => {
        calls.push({ role, messages });
        return {
          answer: `${role} 有效答案`,
          model: role + "-model",
          provider: role === "local" ? "local" : "cloud",
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      }),
  };
  const json = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const ws = createWorkspace({
    repo,
    gateway,
    uploadDir: path.join(dir, "uploads"),
    json,
    readBody,
  });
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
    const data = await res.json();
    return {
      status: res.status,
      data,
      cookie: res.headers.get("set-cookie")?.split(";")[0],
    };
  }
  await request("/auth/setup", {
    username: "admin",
    password: "test-password-123",
    name: "管理",
  });
  const login = await request("/auth/login", {
    username: "admin",
    password: "test-password-123",
  });
  const admin = login.cookie;
  async function add(username, role = "employee", areas = domains) {
    const out = await request(
      "/users",
      {
        username,
        password: "test-password-123",
        name: username,
        role,
        domains: areas,
        active: true,
      },
      admin,
    );
    assert.equal(out.status, 201);
    return {
      ...(await request("/auth/login", {
        username,
        password: "test-password-123",
      })),
      user: out.data.user,
    };
  }
  async function turn(cookie, question = "番茄适用条件", extra = {}) {
    const out = await request(
      "/turns",
      { request_id: randomUUID(), question, domain: domains[0], ...extra },
      cookie,
    );
    assert.equal(out.status, 202, JSON.stringify(out.data));
    await ws.tick("generate");
    return out.data;
  }
  await request(
    "/rules",
    { sample_rate: 0, review_daily_limit: 30, judge_attempts: 1 },
    admin,
  );
  t.after(async () => {
    await ws.stop();
    await new Promise((r) => server.close(r));
    await repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { repo, ws, request, admin, add, turn, calls, dir, base };
}
