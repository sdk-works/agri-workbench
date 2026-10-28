// 老 Android WebView 兼容层
//
// 事故背景：手机上点「登录」直接显示
//   AbortSignal.timeout is not a function
// AbortSignal.timeout 是 Chrome 103+ 才有的静态方法，AbortSignal.any 要 116+。
// 这台机器的系统 WebView 更老，于是 fetch 的 signal 参数在构造时就把异常抛了出去，
// 登录、上传、语音这些请求全部在发出一字节之前就死了。
//
// 这里统一用 AbortController + setTimeout 自己实现，行为对齐原生：
//   - 超时与「用户取消」分开记账（timedOut() / canceled()）
//   - 请求结束后 cleanup() 清计时器、摘事件监听，不泄漏
//   - 能力检测放在函数里，模块导入时不做任何新 API 假设

export const hasAbortSignal =
  typeof AbortSignal !== "undefined" && typeof AbortController !== "undefined";

export const hasAbortTimeout =
  hasAbortSignal && typeof AbortSignal.timeout === "function";

export const hasAbortAny =
  hasAbortSignal && typeof AbortSignal.any === "function";

/**
 * 生成一个带时限的 signal。
 * @param {number} ms 超时毫秒；<=0 表示不限时
 * @param {AbortSignal} [external] 调用方的 signal（用户取消、页面卸载等）
 * @returns {{ signal: AbortSignal|undefined, cleanup: () => void, timedOut: () => boolean, canceled: () => boolean, reason: () => string }}
 */
export function timeoutSignal(ms, external) {
  // 极端情况：连 AbortController 都没有（Chrome < 66）。
  // 这时给 undefined，请求退化成「没有超时保护」，但不会崩成一个看不懂的异常。
  if (!hasAbortSignal) {
    return {
      signal: undefined,
      cleanup() {},
      timedOut: () => false,
      canceled: () => Boolean(external && external.aborted),
      reason: () => (external && external.aborted ? "canceled" : ""),
    };
  }

  const ac = new AbortController();
  let timer = null;
  let timedOut = false;
  let canceled = false;
  let onExternalAbort = null;

  if (external) {
    if (external.aborted) {
      canceled = true;
      ac.abort();
    } else {
      onExternalAbort = () => {
        canceled = true;
        if (!ac.signal.aborted) ac.abort();
      };
      // once 在老 WebView 上支持良好（Chrome 55+）；不支持 options 的极老版本会退化成普通监听，
      // 而 cleanup() 里一定会摘掉，所以不会累积
      try {
        external.addEventListener("abort", onExternalAbort, { once: true });
      } catch (e) {
        external.addEventListener("abort", onExternalAbort);
      }
    }
  }

  if (ms > 0 && !ac.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      if (!ac.signal.aborted) ac.abort();
    }, ms);
  }

  return {
    signal: ac.signal,
    cleanup() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (onExternalAbort && external) {
        try {
          external.removeEventListener("abort", onExternalAbort);
        } catch (e) {}
        onExternalAbort = null;
      }
    },
    timedOut: () => timedOut,
    canceled: () => canceled,
    reason: () => (timedOut ? "timeout" : canceled ? "canceled" : ""),
  };
}

/**
 * 合并多个 signal，任一中断即中断（AbortSignal.any 的兼容实现）。
 * 返回 { signal, cleanup, canceled }
 */
export function combineSignals(signals) {
  const list = (signals || []).filter(Boolean);
  if (!list.length) return { signal: undefined, cleanup() {}, canceled: () => false };
  if (!hasAbortSignal) return { signal: undefined, cleanup() {}, canceled: () => false };

  const ac = new AbortController();
  let canceled = false;
  const handlers = [];

  for (const s of list) {
    if (s.aborted) {
      canceled = true;
      if (!ac.signal.aborted) ac.abort();
      break;
    }
    const h = () => {
      canceled = true;
      if (!ac.signal.aborted) ac.abort();
    };
    handlers.push([s, h]);
    try {
      s.addEventListener("abort", h, { once: true });
    } catch (e) {
      s.addEventListener("abort", h);
    }
  }

  return {
    signal: ac.signal,
    canceled: () => canceled,
    cleanup() {
      for (const [s, h] of handlers) {
        try {
          s.removeEventListener("abort", h);
        } catch (e) {}
      }
      handlers.length = 0;
    },
  };
}

/** crypto.randomUUID 在 Chrome 92 以下没有，用 getRandomValues 拼一个 v4 */
export function uuid() {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch (e) {}
  const bytes = new Uint8Array(16);
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch (e) {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [];
  for (let i = 0; i < 16; i += 1) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

const JS_BUG_RE =
  /is not a function|is not defined|is not a constructor|undefined is not an object|null is not an object|Cannot read propert|Cannot set propert|Unexpected token|Script error/i;
const NET_RE = /Failed to fetch|NetworkError|Load failed|network error|ERR_NETWORK|ERR_CONNECTION/i;
const TIMEOUT_RE = /TimeoutError|timed out|请求超时|响应超时|超时/i;
const ABORT_RE = /AbortError|aborted|已取消/i;

/**
 * 把任意异常翻成人能看懂的一句话。
 * 绝不把 "xxx is not a function" 这类 JavaScript 异常直接摆给用户看，
 * 原文仍然通过 logDiagnostic 落到服务端日志里，便于排查。
 */
export function friendlyError(e, fallback) {
  const raw = String((e && e.message) || e || "");
  if (e && e.timeout) return "服务器响应超时，请检查网络后重试";
  if (e && e.canceled) return "请求已取消";
  if (JS_BUG_RE.test(raw)) {
    return "这个页面的脚本在当前手机浏览器上跑不起来（版本偏旧），请更新系统 WebView 或安装新版 App 后再用";
  }
  if (TIMEOUT_RE.test(raw)) return "服务器响应超时，请检查网络后重试";
  if (NET_RE.test(raw)) return "网络连不上，请确认手机网络或 WiFi 后重试";
  if (ABORT_RE.test(raw)) return "请求已取消";
  if (!raw) return fallback || "操作失败，请重试";
  return raw;
}

/**
 * 诊断日志：控制台留全量，服务端留一行。
 * 服务端那条失败就静默——诊断不能反过来把主流程搞挂。
 */
export function logDiagnostic(tag, detail) {
  const payload = {
    tag: String(tag || "client"),
    message: String((detail && (detail.message || detail)) || ""),
    stack: String((detail && detail.stack) || "").slice(0, 1200),
    ua: typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "",
    url: typeof location !== "undefined" ? String(location.href || "") : "",
    at: new Date().toISOString(),
  };
  try {
    console.warn("[client-diag]", payload.tag, payload.message, payload.ua);
  } catch (e) {}
  try {
    const body = JSON.stringify(payload);
    if (typeof fetch !== "function") return;
    // keepalive 让页面正在卸载时也能发出去；失败不重试、不抛
    fetch("/api/v2/client-diag", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Workbench": "1" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}
}

/** 供页面自检用：这台机器缺哪些能力。每次实时检测，不受模块加载时机影响 */
export function compatProbe() {
  const hasSignal = typeof AbortSignal !== "undefined";
  return {
    abortController: hasSignal && typeof AbortController !== "undefined",
    abortTimeout: hasSignal && typeof AbortSignal.timeout === "function",
    abortAny: hasSignal && typeof AbortSignal.any === "function",
    randomUUID:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function",
    fetch: typeof fetch === "function",
    ua: typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "",
  };
}
