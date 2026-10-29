// 页面级隔离验收：本机 Chrome 经受信任 HTTPS 隧道，打真实测试栈。
// 覆盖：测试标识 / 正常一轮 / 丢响应后的只读对账 / 取消 / 切会话后的后台任务。
import fs from "node:fs";
import path from "node:path";
import {
  launchChrome,
  Cdp,
  clickByText,
  typeInto,
  textOf,
  sleep,
} from "./cdp.mjs";

const BASE = process.env.URL;
const TOKEN = process.env.TOKEN;
if (!BASE || !TOKEN) throw new Error("需要 URL 与 TOKEN 环境变量");
const HOST = new URL(BASE).hostname;
const SHOTS = path.join(process.cwd(), "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (name, cond, extra = "") => {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " | " + extra : ""}`);
  console.log(results.at(-1));
  return cond;
};

async function api(pathname) {
  const res = await fetch(BASE + "/api/v2" + pathname, {
    headers: { "X-Workbench": "1", Cookie: "agri_session=" + TOKEN },
  });
  return res.json();
}

// 每轮验收用独立后缀：同一个问题重复出现会污染"历史里只有一条"这类断言
const RUN = Date.now().toString(36);
const COMPOSER = 'textarea[placeholder*="大棚湿度"]';
const SEND = "form button.primary";
const STOP = "button.text-button.stop";
const NOTICE = "p.success-message";
const ALERT = "p.composer-shot-alert";

const chrome = await launchChrome({ port: 9333 });
const page = await Cdp.attach(chrome.port);
await page.init();
await page.setCookie({ name: "agri_session", value: TOKEN, domain: HOST });

try {
  await page.goto(BASE + "/");
  await page.waitFor(`!!document.querySelector(".wb-top")`, {
    timeout: 40000,
    label: "登录态进入工作台",
  });
  ok("受信任 HTTPS 下页面可进入", true);

  // 1) 测试标识：必须能一眼看出这是隔离测试栈
  const flag = await page.eval(textOf(".test-flag"));
  ok(
    "页面显示测试标识并带实例地址",
    flag.includes("隔离测试版") && flag.includes(HOST),
    flag,
  );
  await page.shot(path.join(SHOTS, "01-home-test-flag.png"));

  // 2) 正常一轮：真实生成，确认改动没有把主流程弄坏
  const qA = `验收A-${RUN}：番茄苗期夜间最低温度建议多少度`;
  await page.eval(typeInto(COMPOSER, qA));
  ok("输入框接受输入", (await page.eval(`document.querySelector('${COMPOSER}').value.length > 0`)));
  await page.eval(clickByText("form button.primary", "发送问题"));
  await page.waitFor(`document.querySelectorAll(".turn").length >= 1`, {
    timeout: 20000,
    label: "出现一条历史",
  });
  const answered = await page.waitFor(
    `(() => {
      const ts = [...document.querySelectorAll(".turn")];
      const last = ts[ts.length - 1];
      const body = last.innerText || "";
      const done = !last.querySelector("button.text-button.stop");
      return done && body.length > 80 ? body.length : 0;
    })()`,
    { timeout: 180000, label: "第一条生成完成" },
  );
  ok("正常一轮能出答案", answered > 80, `文本长度=${answered}`);
  await page.shot(path.join(SHOTS, "02-normal-turn.png"));

  // 3) 丢响应：服务端已经建好轮次，客户端拿不到回执
  // 两种故障可以分别开关：
  //   dropPost  —— 提交响应被丢弃（服务端已建轮次，客户端拿不到回执）
  //   blockVerdict —— 连只读对账（GET /turns/{id}）也断掉，模拟"链路真的断了"
  // 只丢响应、链路还通时，前端会立刻自愈（自动只读对账并确认），
  // 这是好事，但要验证"待确认态 + 手动核对"就必须连对账一起断。
  let dropped = 0;
  let dropPost = true;
  let blockVerdict = true;
  await page.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/v2/turns", requestStage: "Response" },
      { urlPattern: "*/api/v2/turns/*", requestStage: "Request" },
    ],
  });
  page.on("Fetch.requestPaused", async (p) => {
    try {
      const url = p.request.url.split("?")[0];
      const isSubmit = p.request.method === "POST" && /\/api\/v2\/turns$/.test(url);
      const isVerdict = /\/api\/v2\/turns\/[^/]+$/.test(url);
      if (isSubmit && dropPost && dropped === 0) {
        dropped += 1;
        await page.send("Fetch.failRequest", {
          requestId: p.requestId,
          errorReason: "Aborted",
        });
        return;
      }
      if (isVerdict && blockVerdict) {
        await page.send("Fetch.failRequest", {
          requestId: p.requestId,
          errorReason: "InternetDisconnected",
        });
        return;
      }
      await page.send("Fetch.continueRequest", { requestId: p.requestId });
    } catch {}
  });
  const qB = `验收B-${RUN}：丢响应后要对账，不能重复生成`;
  await page.eval(typeInto(COMPOSER, qB));
  await page.eval(clickByText("form button.primary", "发送问题"));
  const unconfirmed = await page.waitFor(
    `(() => {
      const el = document.querySelector("${ALERT}");
      const n = document.querySelector("${NOTICE}");
      const t = ((el && el.innerText) || "") + "|" + ((n && n.innerText) || "");
      return /没收到服务器回执|核对/.test(t) ? t.trim() : "";
    })()`,
    { timeout: 40000, label: "进入待确认态" },
  );
  ok("丢响应后进入状态待确认", unconfirmed.length > 0, unconfirmed.slice(0, 60));
  ok("确实拦截到一次提交响应", dropped === 1, `dropped=${dropped}`);
  const beforeB = (await api("/turns")).items.find((t) => t.question === qB);
  ok("丢响应时服务端其实已经建好了轮次", Boolean(beforeB), beforeB && beforeB.status);

  // 链路也断（blockVerdict 一开始就是 true）：自动对账失败，必须停在"待确认"
  const ALERT_BTN = `(() => {
    const el = document.querySelector("${ALERT}");
    const b = el && el.querySelector("button");
    return b && !b.disabled
      ? (el.innerText || "").replace(/\\s+/g, " ").trim()
      : "";
  })()`;
  const stuck = await page.waitFor(ALERT_BTN, {
    timeout: 20000,
    label: "断链时停在待确认且可点核对",
  });
  ok("链路断时停在待确认态", stuck.length > 0, stuck.slice(0, 46));
  ok("「核对这一条」此时可点（没被锁死）", /核对这一条/.test(stuck), stuck.slice(0, 46));
  // 断网期间点核对：不能把状态弄丢，也不能悄悄补发成第二条
  await page.eval(clickByText("button", "核对这一条"));
  await sleep(1500);
  const stillStuck = await page.eval(ALERT_BTN);
  ok("断网核对后仍停在待确认", Boolean(stillStuck), String(stillStuck).slice(0, 40));
  ok(
    "断网核对没有重复建轮次",
    (await api("/turns")).items.filter((t) => t.question === qB).length === 1,
  );
  await page.shot(path.join(SHOTS, "03-unconfirmed.png"));

  // 恢复链路，再点「核对这一条」：只读对账应当直接确认，不新增轮次
  blockVerdict = false;
  await page.eval(clickByText("button", "核对这一条"));
  await page.eval(clickByText("button", "核对这一条"));
  const confirmed = await page.waitFor(
    `(() => {
      const n = document.querySelector("${NOTICE}");
      const t = (n && n.innerText) || "";
      return /已确认|已补发/.test(t) ? t.trim() : "";
    })()`,
    { timeout: 40000, label: "对账完成" },
  );
  ok("对账给出明确结论", /已确认|已补发/.test(confirmed), confirmed);
  const all = await api("/turns");
  const dupB = (all.items || []).filter((t) => t.question === qB);
  ok("对账后服务端仍只有一条", dupB.length === 1, `count=${dupB.length}`);
  // 对账的关键不是"状态不能是 generating"（那时它本来就在生成），
  // 而是"没有被重新建一遍、也没有被重跑"：创建时间不变、没有重试计数。
  ok(
    "对账没有重新建轮次，也没有打回重跑",
    dupB[0] &&
      dupB[0].created_at === beforeB.created_at &&
      !dupB[0].retry_count,
    `created_at ${dupB[0] && dupB[0].created_at} / retry=${dupB[0] && dupB[0].retry_count}`,
  );
  await page.shot(path.join(SHOTS, "04-reconciled.png"));

  // 4) 取消：生成中点停止必须真的能点，并且服务端确认
  // 只点"这一条"的停止：页面上可能还有前一轮在生成，点错就永远停不到目标轮次
  await page.send("Fetch.disable");
  // 服务端同一会话一次只允许一轮生成（否则 409「上一轮仍在生成」）：
  // 先把上一条收尾，再发这一条，否则根本不会有可点的停止按钮
  let idle = false;
  for (let i = 0; i < 90; i += 1) {
    const act = await api("/turns?active=1");
    if (!(act.items || []).length) {
      idle = true;
      break;
    }
    await sleep(1000);
  }
  ok("上一条已收尾，可以发新的一轮", idle);
  const qC = `验收C-${RUN}：请详细讲讲番茄从定植到采收各阶段的水肥管理要点`;
  await page.eval(typeInto(COMPOSER, qC));
  await page.eval(clickByText("form button.primary", "发送问题"));
  const stopSel = await page.waitFor(
    `(() => {
      const arts = [...document.querySelectorAll("article.turn")];
      const a = arts.find((x) => (x.innerText || "").includes(${JSON.stringify(qC)}));
      if (!a) return "";
      const id = a.dataset.turnId || "";
      const b = a.querySelector("button.text-button.stop");
      return b && !b.disabled && id
        ? 'article.turn[data-turn-id="' + id + '"] button.text-button.stop'
        : "";
    })()`,
    { timeout: 40000, label: "这一轮出现可点的停止按钮" },
  );
  const turnC = stopSel.match(/data-turn-id="([^"]+)"/)[1];
  ok("生成中出现可点的停止按钮（未被锁死）", Boolean(turnC), turnC);
  const clicked = await page.eval(`(() => {
    const b = document.querySelector('${stopSel}');
    if (!b) return false;
    b.scrollIntoView({ block: "center" });
    b.click();
    return true;
  })()`);
  ok("能点到这一条的停止按钮", clicked === true);
  // 要等服务端回执那一句，不能停在"已停止本地等待"
  const cancelNote = await page.waitFor(
    `(() => {
      const n = document.querySelector("${NOTICE}");
      const t = (n && n.innerText) || "";
      return /服务端已确认停止|停止指令已发出|已请求停止/.test(t) ? t.trim() : "";
    })()`,
    { timeout: 30000, label: "服务端取消回执" },
  );
  ok("取消拿到服务端回执", cancelNote.length > 0, cancelNote);

  // 取消是终态：等到终态为止，并且必须落在被取消的那一轮上
  let statusC = "";
  let turnCObj = null;
  for (let i = 0; i < 40; i += 1) {
    const turnsC = await api("/turns");
    turnCObj = (turnsC.items || []).find((t) => t.id === turnC);
    statusC = turnCObj ? turnCObj.status : "";
    if (["canceled", "partial"].includes(statusC)) break;
    await sleep(1000);
  }
  ok(
    "取消后服务端落到终态",
    ["canceled", "partial"].includes(statusC),
    `status=${statusC}`,
  );
  ok("取消的是这一轮，没错停前一条", Boolean(turnCObj) && turnCObj.id === turnC);
  // 终态后再取消一次：必须 200 + already_terminal，不能 404、也不能把它救回生成中
  const again = await fetch(BASE + "/api/v2/turns/" + turnC + "/cancel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Workbench": "1",
      Cookie: "agri_session=" + TOKEN,
    },
    body: "{}",
  }).then((r) => r.json());
  ok(
    "终态后重复取消被识别为已结束",
    again.already_terminal === true && again.status === statusC,
    JSON.stringify(again).slice(0, 80),
  );
  // 迟到完成不能覆盖 cancelled：等几拍再查一次
  await sleep(4000);
  const afterC = (await api("/turns")).items.find((t) => t.id === turnC);
  ok(
    "迟到完成没有覆盖取消终态",
    afterC && ["canceled", "partial"].includes(afterC.status),
    afterC && afterC.status,
  );
  await page.shot(path.join(SHOTS, "05-canceled.png"));

  // 5) 迟到返回 + 后台任务：发出去立刻切新会话
  const qD = `验收D-${RUN}：切走会话后这条还要能追踪`;
  await page.eval(clickByText("button", "新会话"));
  await sleep(600);
  await page.eval(typeInto(COMPOSER, qD));
  await page.eval(clickByText("form button.primary", "发送问题"));
  await page.eval(clickByText("button", "新会话"));
  const bar = await page.waitFor(
    `(() => {
      const el = document.querySelector(".bg-tasks");
      return el ? (el.innerText || "").replace(/\\s+/g, " ").trim() : "";
    })()`,
    { timeout: 40000, label: "后台任务提示条" },
  );
  ok("切会话后能看到在跑的任务", /在别的会话里生成/.test(bar), bar.slice(0, 80));
  const emptyView = await page.eval(`document.querySelectorAll(".turn").length`);
  ok("新会话里没有混入旧会话的回答", emptyView === 0, `turns=${emptyView}`);
  await page.shot(path.join(SHOTS, "06-background.png"));

  // 从提示条直接停掉别的会话里那条
  await page.eval(
    `(() => {const b=document.querySelector(".bg-tasks button.text-button.stop"); if(!b) return false; b.click(); return true;})()`,
  );
  const gone = await page.waitFor(
    `(() => { const el = document.querySelector(".bg-tasks"); return !el ? "gone" : ""; })()`,
    { timeout: 45000, label: "后台任务消失" },
  );
  ok("能从别的会话停掉那条任务", gone === "gone");
  const turnsD = await api("/turns?active=1");
  ok(
    "停掉后不再出现在后台清单",
    !(turnsD.items || []).some((t) => String(t.question).includes("验收D")),
  );
  await page.shot(path.join(SHOTS, "07-background-stopped.png"));

  // 6) 页面自身没有未捕获异常
  ok("页面无未捕获异常", page.pageErrors.length === 0, page.pageErrors.slice(0, 2).join(" / "));
} finally {
  await page.shot(path.join(SHOTS, "99-final.png")).catch(() => {});
  page.close();
  chrome.proc.kill();
  console.log("\n" + results.join("\n"));
  console.log(
    `\n汇总：${results.filter((r) => r.startsWith("PASS")).length}/${results.length} 通过`,
  );
  if (results.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
}
