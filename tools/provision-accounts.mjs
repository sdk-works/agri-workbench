#!/usr/bin/env node
/**
 * 隔离环境账号/凭据运维（不向 stdout 打印密码；密码只写入 0600 文件）
 *
 * 用法：
 *   node tools/provision-accounts.mjs \
 *     --reset admin,jingyang \
 *     --create trial001:employee:种植管理:dep-planting \
 *     --disable-others --purge-sessions
 *
 * 说明：
 *   - 直接改 wb_users.body（scrypt 参数与 server 的 makePassword 保持一致）
 *   - --disable-others 把未列入 --reset/--create 的账号置 active=false
 *   - --purge-sessions 删除 wb_sessions 全部行（停用账号的会话不留在库里）
 */
import { execFileSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";

const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
const val = (n, d = null) => {
  const i = argv.indexOf("--" + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const DB = process.env.ISO_DB || "/home/jingyang/agri-dev/data/iso.sqlite";
const CRED_OUT =
  process.env.CRED_OUT || "/home/jingyang/agri-dev/.bak/credentials-trial.txt";

const run = (sqlText) =>
  execFileSync("sqlite3", [DB, sqlText], { encoding: "utf8", maxBuffer: 64 << 20 });
const lit = (s) => `CAST(X'${Buffer.from(String(s), "utf8").toString("hex")}' AS TEXT)`;

function loadUsers() {
  const raw = run("select hex(id)||'|'||hex(body) from wb_users;").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => {
    const [idh, bodyh] = l.split("|");
    const u = JSON.parse(Buffer.from(bodyh, "hex").toString("utf8"));
    u.id = Buffer.from(idh, "hex").toString("utf8") || u.id;
    return u;
  });
}

function upsert(u) {
  const body = JSON.stringify(u);
  run(
    `INSERT INTO wb_users (id,tenant,owner,domain,status,created_at,body)
     VALUES(${lit(u.id)},${lit(u.tenant || "park")},${lit(u.owner || "")},${lit(u.domain || "")},${lit(u.status || "")},${lit(u.created_at)},${lit(body)})
     ON CONFLICT(id) DO UPDATE SET tenant=excluded.tenant,owner=excluded.owner,domain=excluded.domain,status=excluded.status,body=excluded.body;`,
  );
}

// 与 server 的 makePassword 同参数：scrypt(password, salt, 64) 默认 N=16384,r=8,p=1
const genPw = () => randomBytes(16).toString("base64url"); // 22 chars, 128bit
const hashPw = (p) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(p, salt, 64).toString("hex")}`;
};
const nowIso = () => new Date().toISOString();

const users = loadUsers();
const byName = new Map(users.map((u) => [u.username, u]));
const issued = []; // {username, role, password, action}
const touched = new Set();

// 1) 重置指定账号密码
const resetList = String(val("reset", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const name of resetList) {
  const u = byName.get(name);
  if (!u) {
    console.error(`[skip] 不存在：${name}`);
    continue;
  }
  const pw = genPw();
  u.password = hashPw(pw);
  u.active = true;
  upsert(u);
  touched.add(name);
  issued.push({ username: name, role: u.role, password: pw, action: "密码已重置" });
}

// 2) 新建/更新指定试用账号  username:role:domainName:deptId
const createList = String(val("create", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const spec of createList) {
  const [username, role = "employee", domain = "", deptId = ""] = spec.split(":");
  if (!/^[a-z0-9_.-]{3,60}$/.test(username)) {
    console.error(`[skip] 非法账号名：${username}`);
    continue;
  }
  const pw = genPw();
  const exist = byName.get(username);
  if (exist) {
    exist.password = hashPw(pw);
    exist.active = true;
    upsert(exist);
    touched.add(username);
    issued.push({ username, role: exist.role, password: pw, action: "已存在→重置密码" });
    continue;
  }
  const u = {
    id: cryptoRandomUuid(),
    tenant: "park",
    created_at: nowIso(),
    username,
    name: username,
    password: hashPw(pw),
    role,
    domains: domain ? [domain] : [],
    active: true,
    ...(role === "employee" || role === "expert"
      ? {}
      : { scope_all: true }),
  };
  if (deptId) u.dept_ids = [deptId];
  upsert(u);
  touched.add(username);
  issued.push({ username, role, password: pw, action: "新建" });
}

// 3) 停用其余账号
const disabled = [];
if (has("disable-others")) {
  for (const u of users) {
    if (touched.has(u.username)) continue;
    if (u.active === false) continue;
    u.active = false;
    upsert(u);
    disabled.push(u.username);
  }
}

// 4) 清会话
let purged = 0;
if (has("purge-sessions")) {
  const c = run("select count(*) from wb_sessions;").trim();
  purged = Number(c || 0);
  run("delete from wb_sessions;");
}

// 5) 凭据落盘（0600）
if (!issued.length) {
  console.log("没有新建/重置账号，未写凭据文件。");
} else {
  const lines = [
    "# 隔离测试环境凭据（一次性交付）",
    `# 生成时间：${nowIso()}`,
    `# 数据库：${DB}`,
    "# 用途：京阳智农 AI 隔离试用环境，公网入口 https://42.193.104.148",
    "# 约束：不得粘贴进文档/聊天/工单；泄露后立即轮换（重跑本脚本 --reset）",
    "",
  ];
  for (const i of issued) {
    lines.push(`账号：${i.username}`);
    lines.push(`口令：${i.password}`);
    lines.push(`角色：${i.role}（${i.action}）`);
    lines.push("");
  }
  fs.writeFileSync(CRED_OUT, lines.join("\n"), { mode: 0o600 });
  fs.chmodSync(CRED_OUT, 0o600);
}

console.log(
  JSON.stringify(
    {
      reset: resetList.filter((n) => touched.has(n)),
      created: issued.filter((i) => i.action === "新建").map((i) => i.username),
      reset_existing: issued.filter((i) => i.action !== "新建").map((i) => i.username),
      disabled,
      sessions_purged: purged,
      credential_file: issued.length ? CRED_OUT : null,
    },
    null,
    2,
  ),
);

function cryptoRandomUuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
