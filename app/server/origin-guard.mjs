// 页面来源（Origin）校验。
//
// 为什么单独成文件：这是安全相关的判定，必须能脱离 HTTP 服务单独测。
// 之前它内嵌在 server.mjs 里，没有测试覆盖，结果通配符实现错了很久才被发现。
//
// 两种放行方式：
//   1) 精确匹配 —— 配置里逐条列出的来源。
//   2) 通配匹配 —— 配置里写成 https://*.example.com 这种形式。
//      Cloudflare Tunnel 的 quick tunnel 每次重启域名都变，逐条列不现实。
//
// 通配符在中间（https://*.example.com），不能简单地去掉前缀 ——
// 那会得到 "https://.example.com"，永远匹配不上（这是踩过的坑）。
// 这里把 * 转成正则里的「任意不含斜杠的字符」，再做整体精确匹配。

const ESCAPE_RE = /[.+?^${}()|[\]\\]/g;

export function buildOriginMatcher(list) {
  const exact = new Set(
    (Array.isArray(list) ? list : String(list || "").split(","))
      .map((s) => String(s).trim())
      .filter(Boolean),
  );
  const patterns = [...exact]
    .filter((o) => o.includes("*"))
    .map((o) => {
      const escaped = o.replace(ESCAPE_RE, "\\$&").replace(/\*/g, "[^/]*");
      return new RegExp("^" + escaped + "$");
    });
  return function originAllowed(origin) {
    if (!origin) return true; // 没有 Origin 头：同源导航、curl 等，不拦
    if (exact.has(origin)) return true;
    return patterns.some((re) => re.test(origin));
  };
}
