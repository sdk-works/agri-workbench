import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRepository } from "./repository.mjs";
import { loadEnv } from "./env.mjs";
const env = loadEnv(),
  root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (env.DATABASE_URL)
  throw Error(
    "PostgreSQL 请使用 pg_dump，并备份 UPLOAD_PATH 和 MODEL_CONFIG_PATH",
  );
const source =
    env.WORKSPACE_DATA_PATH || path.join(root, "data/workspace.sqlite"),
  target = process.argv[2] && path.resolve(process.argv[2]);
if (!target)
  throw Error("请指定新的备份目录，例如 npm run backup -- backups/2026-10-09");
if (!fs.existsSync(source)) throw Error("工作台数据库不存在");
if (fs.existsSync(target)) throw Error("目标目录已存在，请使用新目录");
const uploads = env.UPLOAD_PATH || path.join(root, "uploads"),
  config = env.MODEL_CONFIG_PATH || path.join(root, "data/model-config.json");
for (const input of [source, uploads, config]) {
  const relative = path.relative(path.resolve(input), target);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    throw Error("备份目录不能位于源文件或上传目录内部");
}
fs.mkdirSync(target, { recursive: true });
const repo = await openRepository({ filename: source });
try {
  await repo.backup(path.join(target, "workspace.sqlite"));
  if (fs.existsSync(uploads))
    fs.cpSync(uploads, path.join(target, "uploads"), {
      recursive: true,
      errorOnExist: true,
    });
  if (fs.existsSync(config))
    fs.copyFileSync(config, path.join(target, "model-config.json"));
  fs.writeFileSync(
    path.join(target, "RESTORE.txt"),
    "停止服务后恢复 workspace.sqlite、uploads 目录和 model-config.json。不要覆盖运行中的 SQLite WAL 文件。此备份包含账号哈希、业务原文和可能存在的 API 密钥，应限制读取权限。\n",
  );
  console.log("工作台数据库、原始资料与模型配置已备份");
} finally {
  await repo.close();
}
