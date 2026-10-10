export async function call(path, body, method) {
  const res = await fetch("/api/v2" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Workbench": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (!res.ok) {
    const error = Error(data.error || `请求失败 ${res.status}`);
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
