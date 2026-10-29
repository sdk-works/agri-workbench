// 极简 CDP 驱动：不依赖 playwright/puppeteer，直接用本机 Chrome 的调试协议。
// 目的：在本机浏览器上经受信任 HTTPS 隧道跑页面级验收（挂起、丢响应、迟到、取消）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({
  exe = "C:/Users/salut/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe",
  port = 9333,
  userDataDir,
} = {}) {
  const dir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "cdp-prof-"));
  const proc = spawn(
    exe,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=430,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let lastErr = "";
  proc.stderr.on("data", (d) => (lastErr = String(d).slice(0, 400)));
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return { proc, port, dir, version: await r.json() };
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome 没有起来: " + lastErr);
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.pageErrors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        if (msg.method === "Runtime.exceptionThrown")
          this.pageErrors.push(
            msg.params?.exceptionDetails?.exception?.description || "exception",
          );
        const hs = this.handlers.get(msg.method);
        if (hs) for (const h of hs) h(msg.params);
      }
    });
  }

  static async attach(port, url) {
    // 新建一个标签页，避免复用 about:blank 的历史状态
    const r = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url || "about:blank")}`,
      { method: "PUT" },
    );
    if (!r.ok) throw new Error("建标签页失败 " + r.status);
    const target = await r.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws 连接失败")), {
        once: true,
      });
    });
    const c = new Cdp(ws);
    c.targetId = target.id;
    return c;
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, 60000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  async init() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
  }

  async eval(expr) {
    const out = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out.exceptionDetails)
      throw new Error(
        "页面脚本报错: " +
          (out.exceptionDetails.exception?.description || out.exceptionDetails.text),
      );
    return out.result.value;
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
    for (let i = 0; i < 120; i += 1) {
      const ok = await this.eval(
        `document.readyState === "complete" && !!document.body`,
      );
      if (ok) return;
      await sleep(250);
    }
  }

  async waitFor(expr, { timeout = 45000, label = expr } = {}) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try {
        last = await this.eval(expr);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(300);
    }
    throw new Error(`等待超时(${timeout}ms): ${label} 最后=${JSON.stringify(last)}`);
  }

  async shot(file) {
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  async setCookie({ name, value, domain, secure = true }) {
    return this.send("Network.setCookie", {
      name,
      value,
      domain,
      path: "/",
      secure,
      httpOnly: true,
      sameSite: "Strict",
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/* 页面小工具：都走 Runtime.evaluate，避免引入额外依赖 */

export const clickByText = (selector, text) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const el = els.find((e) => (e.innerText || e.textContent || "").trim().includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.scrollIntoView({block:"center"});
  el.click();
  return true;
})()`;

export const typeInto = (selector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value.length > 0;
})()`;

export const textOf = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  return el ? (el.innerText || el.textContent || "").trim() : "";
})()`;

export { sleep };
