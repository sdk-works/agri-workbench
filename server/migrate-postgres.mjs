import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRepository, kinds } from "./repository.mjs";
import { loadEnv } from "./env.mjs";
const env = loadEnv(),
  root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source =
  env.WORKSPACE_DATA_PATH || path.join(root, "data/workspace.sqlite");
if (!env.DATABASE_URL) throw Error("请设置目标 DATABASE_URL；不会输出连接凭据");
if (!fs.existsSync(source)) throw Error("本地工作台数据库不存在");
const input = await openRepository({ filename: source }),
  output = await openRepository({ databaseUrl: env.DATABASE_URL });
try {
  const snapshot = {};
  for (const kind of kinds)
    snapshot[kind] = kind === "sessions" ? [] : await input.list(kind);
  const counts = await output.transaction(async (db) => {
    for (const kind of kinds)
      if ((await db.list(kind)).length)
        throw Error("目标数据库必须为空，未覆盖已有数据");
    const result = {};
    for (const kind of kinds) {
      for (const item of snapshot[kind]) await db.put(kind, item);
      result[kind] = snapshot[kind].length;
      const actual = await db.list(kind);
      if (actual.length !== result[kind]) throw Error("迁移计数校验失败");
      for (const item of actual) {
        const expected = snapshot[kind].find((r) => r.id === item.id);
        if (JSON.stringify(expected) !== JSON.stringify(item))
          throw Error("迁移内容校验失败");
      }
    }
    return result;
  });
  console.log(
    JSON.stringify(
      {
        migrated: counts,
        sessions: "登录会话未迁移，需重新登录",
        note: "源库保留；上传目录与模型配置仍需保留或复制。切换前请停止旧服务写入。",
      },
      null,
      2,
    ),
  );
} finally {
  await input.close();
  await output.close();
}
