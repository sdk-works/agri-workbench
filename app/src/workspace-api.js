import { timeoutSignal, friendlyError, logDiagnostic } from "./compat.js";

// 默认 60 秒。老 WebView 上 AbortSignal.timeout 不存在，
// 所以统一走 compat.js 的 AbortController + setTimeout 版本。
const DEFAULT_TIMEOUT_MS = 60000;

export async function call(path, body, method, options) {
  const opts = options || {};
  const t = timeoutSignal(
    opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs,
    opts.signal,
  );
  // 请求 + 读 body 全程受同一个计时器约束：只护住 fetch 的 headers
  // 会让慢网下 res.text() 无限挂着（那时计时器已经清掉了）
  try {
    const res = await fetch("/api/v2" + path, {
      method: method || (body === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Workbench": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: t.signal,
    });
    // 先读文本再判空/解析：空 body（204 或偶发空响应）不抛 DOMException，也不绕过状态检查
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("服务返回了无法解析的响应");
      }
    }
    if (!res.ok) {
      const error = Error((data && data.error) || `请求失败 ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return data;
  } catch (e) {
    // 超时：计时器把 signal 掐了，给一句能看懂的话，并标记 timeout 供上层区分
    if (t.timedOut()) {
      logDiagnostic("api-timeout", { message: `${path} ${opts.timeoutMs || DEFAULT_TIMEOUT_MS}ms` });
      throw Object.assign(new Error("服务器响应超时，请检查网络后重试"), {
        status: 0,
        timeout: true,
      });
    }
    // 取消：调用方主动 abort（切会话、页面卸载、用户点了停），不当故障报
    if (t.canceled() || (e && e.name === "AbortError")) {
      throw Object.assign(new Error("请求已取消"), { canceled: true });
    }
    // 已经是业务错误（带 status）就原样抛，别把服务端的说明吃掉
    if (e && e.status) throw e;
    const raw = String((e && e.message) || e || "");
    // 只有真正的意外才落诊断日志：网络抖动每几百次就有一次，不必刷屏
    if (!/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
      logDiagnostic("api-error", { message: `${path}: ${raw}`, stack: (e && e.stack) || "" });
    }
    throw new Error(friendlyError(e, "请求失败，请重试"));
  } finally {
    t.cleanup();
  }
}

export function download(data, name) {
  const url = URL.createObjectURL(
    new Blob([data], { type: "application/json;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
