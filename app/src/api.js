// The UI only calls this adapter. No provider key belongs in the browser.
import { timeoutSignal, friendlyError, logDiagnostic } from "./compat.js";

export const API_BASE = import.meta.env.VITE_API_BASE || '/api/v1';
const DEFAULT_TIMEOUT_MS = 60000;

export async function request(path, options = {}) {
  // 老 WebView 没有 AbortSignal.timeout，统一走兼容层
  const t = timeoutSignal(DEFAULT_TIMEOUT_MS, options.signal);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      signal: t.signal,
    });
    if (!response.ok) { const body=await response.json().catch(()=>({})); throw new Error(body.error || `服务请求失败（${response.status}）`); }
    return response.status === 204 ? null : response.json();
  } catch (e) {
    if (t.timedOut()) throw Object.assign(new Error("服务器响应超时，请检查网络后重试"), { status: 0, timeout: true });
    if (t.canceled() || (e && e.name === "AbortError")) throw Object.assign(new Error("请求已取消"), { canceled: true });
    if (e && e.status) throw e;
    logDiagnostic("api1-error", { message: `${path}: ${(e && e.message) || e}`, stack: (e && e.stack) || "" });
    throw new Error(friendlyError(e, "请求失败，请重试"));
  } finally {
    t.cleanup();
  }
}
export const api = {
  comparisons: () => request('/comparisons'),
  comparison: (id) => request(`/comparisons/${id}`),
  createComparison: (payload) => request('/comparisons', {method:'POST',body:JSON.stringify(payload)}),
  choose: (id,payload) => request(`/comparisons/${id}/choice`, {method:'POST',body:JSON.stringify(payload)}),
  revise: (id,payload) => request(`/comparisons/${id}/revision`, {method:'POST',body:JSON.stringify(payload)}),
  approve: (id,payload) => request(`/comparisons/${id}/approve`, {method:'POST',body:JSON.stringify(payload)}),
  exclude: (id,payload) => request(`/comparisons/${id}/exclude`, {method:'POST',body:JSON.stringify(payload)}),
  exportDataset: (kind) => request('/datasets/export', {method:'POST',body:JSON.stringify({kind})}),
  chat: (payload) => request('/chat', { method: 'POST', body: JSON.stringify(payload) }),
  similarity: (textA, textB) => request('/similarity', { method: 'POST', body: JSON.stringify({ text_a: textA, text_b: textB }) }),
  judge: (question, answerA, answerB) => request('/judge', { method: 'POST', body: JSON.stringify({ question, answer_a: answerA, answer_b: answerB }) }),
  models: () => request('/models'),
  review: (id, payload) => request(`/reviews/${id}`, { method: 'POST', body: JSON.stringify(payload) }),
  documents: () => request('/documents'),
};
