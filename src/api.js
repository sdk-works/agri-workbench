// The UI only calls this adapter. No provider key belongs in the browser.
export const API_BASE = import.meta.env.VITE_API_BASE || '/api/v1';
export async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: options.signal || AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`服务请求失败（${response.status}）`);
  return response.status === 204 ? null : response.json();
}
export const api = {
  chat: (payload) => request('/chat', { method: 'POST', body: JSON.stringify(payload) }),
  similarity: (textA, textB) => request('/similarity', { method: 'POST', body: JSON.stringify({ text_a: textA, text_b: textB }) }),
  judge: (question, answerA, answerB) => request('/judge', { method: 'POST', body: JSON.stringify({ question, answer_a: answerA, answer_b: answerB }) }),
  models: () => request('/models'),
  review: (id, payload) => request(`/reviews/${id}`, { method: 'POST', body: JSON.stringify(payload) }),
  documents: () => request('/documents'),
};
