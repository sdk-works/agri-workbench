/**
 * cloud-fetch.mjs —— 云端（境外）模型请求专用通道
 *
 * 为什么需要它：
 *   141 → api.openai.com 必须经本机 mihomo 代理，且实测 TLS 握手需要 11–16 秒
 *   （新加坡 13.0s / 日本 11.2s / 香港 16s 失败）。Node 内置 fetch 的
 *   connect timeout 固定 10s，握手没结束就被掐断，报 UND_ERR_CONNECT_TIMEOUT。
 *   这里用 undici + ProxyAgent 把连接超时放宽到 45s，并保证：
 *     - 本地/内网地址（Ollama 11434、127.0.0.1、NO_PROXY 里的）一律直连，
 *       绝不被绕进代理，否则本地模型会整个变慢甚至不可用；
 *     - undici 加载失败时静默退回原生 fetch，不影响服务启动。
 */
let undici = null;
try {
  undici = await import("file:///home/jingyang/agri-ai/toolchain/node_modules/undici/index.js");
} catch {
  try {
    undici = await import("undici");
  } catch {
    undici = null;
  }
}

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || "";
const BYPASS = String(process.env.NO_PROXY || process.env.no_proxy || "")
  .split(",")
  .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
  .filter(Boolean);

function isBypass(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // 解析不了就别塞进代理
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0")
    return true;
  return BYPASS.some((n) => host === n || host.endsWith("." + n));
}

let agent = null;
if (undici && PROXY_URL) {
  try {
    agent = new undici.ProxyAgent({
      uri: PROXY_URL,
      // TCP + TLS 握手整体预算：境外汇聚节点实测 11–16s，务必留足
      connect: { timeout: 45_000 },
      headersTimeout: 180_000,
      bodyTimeout: 0, // 流式回答不能因为两句话之间停顿被判超时
      keepAliveTimeout: 60_000,
    });
    console.log(`[cloud-fetch] 代理通道就绪 ${PROXY_URL}`);
  } catch (e) {
    console.error("[cloud-fetch] ProxyAgent 创建失败，退回直连:", e?.message || e);
    agent = null;
  }
} else {
  console.log("[cloud-fetch] 未启用代理（无 HTTPS_PROXY 或 undici 缺失），走原生 fetch");
}

export function cloudFetch(url, init = {}) {
  const u = typeof url === "string" ? url : url?.url || String(url);
  if (!agent || isBypass(u)) return fetch(u, init);
  return undici.fetch(u, { ...init, dispatcher: agent });
}

export const __test__ = { isBypass, hasAgent: Boolean(agent) };
