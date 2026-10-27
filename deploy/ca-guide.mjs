// 公网明文入口专用：只提供「证书安装引导」静态资源，不代理任何业务 API。
// 背景：原先 18099 直通 8099 网关，等于把完整 HTTP 应用暴露在公网明文上。
// 现在 18099 只映射到本服务（127.0.0.1:18098），白名单三条路径，其余一律 404。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.GUIDE_PORT || 18098);
const HOST = process.env.GUIDE_HOST || "127.0.0.1";
const ROOT = path.resolve(
  process.env.WEB_ROOT || "/home/jingyang/agri-dev/web-dist",
);

// 只有这三条路径存在；没有 SPA 回退，没有 /api 代理，没有目录浏览
const ROUTES = {
  "/": ["ca.html", "text/html; charset=utf-8"],
  "/ca.html": ["ca.html", "text/html; charset=utf-8"],
  "/jingyang-ca.crt": ["jingyang-ca.crt", "application/x-x509-ca-cert"],
};

const baseHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
};

http
  .createServer((req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { ...baseHeaders, Allow: "GET, HEAD" });
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      res.writeHead(400, baseHeaders);
      res.end();
      return;
    }
    const hit = ROUTES[pathname];
    if (!hit) {
      res.writeHead(404, {
        ...baseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end(
        "此入口仅用于下载根证书与查看安装说明，不提供业务功能。\n请使用 HTTPS 入口访问工作台。\n",
      );
      return;
    }
    const file = path.join(ROOT, hit[0]);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(500, { ...baseHeaders, "Content-Type": "text/plain" });
        res.end("guide file missing");
        return;
      }
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": hit[1],
        "Content-Length": buf.length,
      });
      if (req.method === "HEAD") res.end();
      else res.end(buf);
    });
  })
  .listen(PORT, HOST, () => console.log(`[ca-guide] ${HOST}:${PORT} root=${ROOT}`));
