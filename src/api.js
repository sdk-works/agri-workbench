// The UI only calls this adapter. No provider key belongs in the browser.
export const API_BASE = import.meta.env.VITE_API_BASE || '/api/v1';
export async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: options.signal || AbortSignal.timeout(60000),
  });
  if (!response.ok) { const body=await response.json().catch(()=>({})); throw new Error(body.error || `服务请求失败（${response.status}）`); }
  return response.status === 204 ? null : response.json();
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
