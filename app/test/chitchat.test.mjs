/**
 * 招呼拦截回归测试。
 *
 * 直接从 WorkspaceApp.vue 里抽出 chitChatReply 及其依赖常量来跑，
 * 不复制一份实现——否则测试通过、线上仍然错（这个坑踩过）。
 *
 * 跑法：node test/chitchat.test.mjs   （在 app/ 下）
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// 同一份脚本可能放在 app/test/ 也可能和 .vue 放一起，两个位置都试
const candidates = [
  join(here, "WorkspaceApp.vue"),
  join(here, "..", "src", "WorkspaceApp.vue"),
];
const vuePath = candidates.find((p) => existsSync(p));
if (!vuePath) {
  console.error("找不到 WorkspaceApp.vue，试过：\n" + candidates.join("\n"));
  process.exit(2);
}
const src = readFileSync(vuePath, "utf8");

const start = src.indexOf("const GREET_TOKENS = [");
const end = src.indexOf("async function askStreaming");
if (start < 0 || end < 0) {
  console.error("抽取失败：没找到 GREET_TOKENS 或 askStreaming");
  process.exit(2);
}
const block = src.slice(start, end);
const chitChatReply = new Function(block + "\nreturn chitChatReply;")();

// [用户原话, 期望是否被拦成招呼]
const CASES = [
  // 纯招呼 / 试麦 / 口头语 → 必须拦
  ["喂", true],
  ["喂喂喂", true],
  ["为为为", true],
  ["你好", true],
  ["您好呀", true],
  ["在吗", true],
  ["听得到吗", true],
  ["能听见吗", true],
  ["测试一下", true],
  ["连接正常吗", true],
  ["谢谢", true],
  ["好的", true],
  ["收到！", true],
  // 带实义的短句 → 必须进模型
  ["你好，叶子黄了怎么办", false],
  ["好的，这个虫怎么处理", false],
  ["喂，三号棚湿度多少", false],
  ["在吗，帮我看看苗", false],
  ["谢谢，那我明天再打药吗", false],
  ["为什么", false],
  ["位置在哪", false],
  ["你好，我家大棚番茄叶子发黄还有斑点，打什么药好", false],
  ["红蜘蛛用什么药", false],
  ["卷帘机不动了", false],
  ["", true], // 空串按原逻辑回一句"我在"
  ["   ", true],
];

let fail = 0;
for (const [text, expected] of CASES) {
  const got = chitChatReply(text);
  const intercepted = Boolean(got);
  const ok = intercepted === expected;
  if (!ok) fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${JSON.stringify(text).padEnd(30)} ` +
      `拦截=${intercepted ? JSON.stringify(got) : "否"}`,
  );
}
console.log(fail === 0 ? `\n全部通过（${CASES.length} 条）` : `\n失败 ${fail} 条`);
process.exit(fail === 0 ? 0 : 1);
