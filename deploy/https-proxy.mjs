// 本地 HTTPS 入口：为浏览器提供安全上下文（麦克风/摄像头只在 https 下可用）
//
// 两个监听面：
//   HTTPS_PORT (8543)：局域网/本机直连。无 PROXY 头，来源 = socket.remoteAddress。
//   PP_PORT    (8544)：frpc 回源专用。frpc 侧 transport.proxyProtocolVersion = "v2"，
//                      首包带真实公网来源 IP。严格模式：不带 PROXY 头直接断开，
//                      防止有人直连这个端口伪造来源。
//
// 为什么不用 https.createServer 直接收 PROXY 头：
//   TLS 层的 connection 监听器比我们的先注册，会先把 socket 包成 TLSSocket 并开始读，
//   我们再 pause 已经太晚（已实测：443 直接 SSL error）。
//   正解是先用 net.Server(pauseOnConnect) 收包、解析完 PROXY 头，再 emit 给 https server。
//
// 下游只信这一层写进去的 x-forwarded-for：覆盖写入，客户端自带的 XFF/Forwarded 丢弃。
import https from "node:https";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";

const PLAIN_PORT = Number(process.env.HTTPS_PORT || 8543);
const PP_PORT = Number(process.env.PP_PORT || 0);
const UPSTREAM = {
  host: "127.0.0.1",
  port: Number(process.env.UPSTREAM_PORT || 8080),
};
const CERT = process.env.TLS_CERT || "/home/jingyang/agri-ai/deploy/tls/agri.crt";
const KEY = process.env.TLS_KEY || "/home/jingyang/agri-ai/deploy/tls/agri.key";

const TLS_OPTS = { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) };

// req.socket 是 TLSSocket，真实来源记在它包装的底层 socket 上，需要沿 _parent 找
function srcOf(socket) {
  let s = socket;
  for (let i = 0; i < 4 && s; i += 1) {
    if (s._srcIp) return s._srcIp;
    s = s._parent || null;
  }
  return (socket && socket.remoteAddress) || "";
}

function headersFor(req) {
  const h = {
    ...req.headers,
    "x-forwarded-proto": "https",
    "x-forwarded-for": srcOf(req.socket), // 覆盖写入
  };
  delete h.forwarded;
  delete h["x-real-ip"];
  return h;
}

function onRequest(req, res) {
  const up = http.request(
    {
      host: UPSTREAM.host,
      port: UPSTREAM.port,
      method: req.method,
      path: req.url,
      headers: headersFor(req),
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res); // 支持 SSE / 流式
    },
  );
  up.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("upstream error: " + e.message);
    } else res.destroy();
  });
  req.pipe(up);
}

function onUpgrade(req, socket, head) {
  const up = http.request({
    host: UPSTREAM.host,
    port: UPSTREAM.port,
    method: req.method,
    path: req.url,
    headers: {
      ...headersFor(req),
      connection: "Upgrade",
      upgrade: req.headers.upgrade,
    },
  });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(upRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  up.on("error", () => socket.destroy());
  if (head && head.length) up.write(head);
  up.end();
}

// PROXY protocol v2
const V2_SIG = Buffer.from("0d0a0d0a000d0a515549540a", "hex"); // \r\n\r\n\0\r\nQUIT\n = 12B
function parseV2(buf) {
  if (buf.length < 16) return { need: true };
  if (!buf.subarray(0, 12).equals(V2_SIG)) return { invalid: true };
  const cmd = buf[12] & 0x0f; // 0=LOCAL, 1=PROXY
  const fam = buf[13] >> 4; // 1=AF_INET, 2=AF_INET6
  const len = buf.readUInt16BE(14);
  if (buf.length < 16 + len) return { need: true };
  const addr = buf.subarray(16, 16 + len);
  const rest = buf.subarray(16 + len);
  if (cmd !== 1) return { src: null, rest };
  if (fam === 1) return { src: `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`, rest };
  if (fam === 2) {
    const g = [];
    for (let i = 0; i < 16; i += 2) g.push(addr.readUInt16BE(i).toString(16));
    return { src: g.join(":"), rest };
  }
  return { src: null, rest };
}

// 直连面：普通 https server
const plain = https.createServer(TLS_OPTS, onRequest);
plain.on("upgrade", onUpgrade);

// 隧道面：先解析 PROXY 头，再交给 https server
const tlsOnly = https.createServer(TLS_OPTS, onRequest);
tlsOnly.on("upgrade", onUpgrade);
tlsOnly.on("tlsClientError", () => {});

const ppServer = net.createServer({ pauseOnConnect: true }, (socket) => {
  let buf = Buffer.alloc(0);
  const bail = () => {
    socket.removeAllListeners("readable");
    socket.destroy();
  };
  socket.setTimeout(8000, bail);
  socket.on("error", bail);
  socket.on("readable", () => {
    let chunk;
    while ((chunk = socket.read()) !== null) buf = Buffer.concat([buf, chunk]);
    const r = parseV2(buf);
    if (r.need) {
      if (buf.length > 1024) bail();
      return;
    }
    if (r.invalid) {
      console.warn(`[https] rejected non-PROXY connection from ${socket.remoteAddress}`);
      bail();
      return;
    }
    socket.removeAllListeners("readable");
    socket.setTimeout(0);
    socket._srcIp = r.src || socket.remoteAddress;
    if (r.rest && r.rest.length) socket.unshift(r.rest);
    tlsOnly.emit("connection", socket); // 交给 TLS 层开始握手
    socket.resume(); // 必须显式恢复：pauseOnConnect 的 socket 不改 flowing 状态，TLS 读不到数据
  });
});

if (PP_PORT && PP_PORT !== PLAIN_PORT) {
  ppServer.listen(PP_PORT, "127.0.0.1", () =>
    console.log(
      `[https] :${PP_PORT} (frpc, PROXY v2 required) -> ${UPSTREAM.host}:${UPSTREAM.port}`,
    ),
  );
}
plain.listen(PLAIN_PORT, "0.0.0.0", () =>
  console.log(`[https] :${PLAIN_PORT} -> ${UPSTREAM.host}:${UPSTREAM.port}`),
);
