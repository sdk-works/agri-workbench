export async function call(path, body, method) {
  const res = await fetch("/api/v2" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Workbench": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
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
