import http from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 语音增强路由（挂在 /api/v2/voice/*）
 *  - GET  /status  语音服务健康
 *  - POST /asr     原始音频 → 识别文本
 *  - POST /tts     JSON → MP3
 *  - POST /turn    JSON → SSE 流式回答（服务端落库，统一会话历史）
 *  - POST /answer  JSON → SSE 流式回答（旧版兼容，不落库）
 *
 * 鉴权：复用现有会话，内部回调 /api/v2/auth/status 校验 Cookie。
 */
export function createVoice({ env, json, readBody, gateway, workspace }) {
  const voicePort = Number(env.VOICE_PORT || 8790);
  const apiPort = Number(env.PORT || 8787);
  // 语音专用小模型：首字延迟 ~30ms（27B 主模型给工作台用）
  const voiceModel = env.VOICE_MODEL || "qwen2.5:3b";
  const ollamaUrl = env.OLLAMA_URL || "http://127.0.0.1:11434";
  const allowLocal = env.VOICE_ALLOW_LOCAL === "1";

  async function streamOllama(messages, onDelta, signal) {
    const res = await fetch(ollamaUrl.replace(/\/$/, "") + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: voiceModel,
        messages,
        stream: true,
        keep_alive: "30m",
        options: { temperature: 0.6, num_predict: 200 },
      }),
      signal,
    });
    if (!res.ok || !res.body) throw Error("语音模型不可用(" + res.status + ")");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const delta = (obj.message || {}).content;
        if (delta) onDelta(delta);
        if (obj.done) return;
      }
    }
  }

  function readRaw(req, limit = 12_000_000) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(Error("音频过大"), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function currentUser(req) {
    return new Promise((resolve) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port: apiPort,
          path: "/api/v2/auth/status",
          method: "GET",
          headers: { cookie: req.headers.cookie || "" },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode !== 200) return resolve(null);
            try {
              resolve(JSON.parse(data).user || null);
            } catch {
              resolve(null);
            }
          });
        },
      );
      r.on("error", () => resolve(null));
      r.setTimeout(3000, () => {
        r.destroy();
        resolve(null);
      });
      r.end();
    });
  }

  function authorized(req) {
    return new Promise((resolve) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port: apiPort,
          path: "/api/v2/auth/status",
          method: "GET",
          headers: { cookie: req.headers.cookie || "" },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode !== 200) return resolve(false);
            try {
              resolve(Boolean(JSON.parse(data).user));
            } catch {
              resolve(false);
            }
          });
        },
      );
      r.on("error", () => resolve(false));
      r.setTimeout(3000, () => {
        r.destroy();
        resolve(false);
      });
      r.end();
    });
  }

  function toPython(path, method, headers, body) {
    return new Promise((resolve, reject) => {
      const r = http.request(
        { hostname: "127.0.0.1", port: voicePort, path, method, headers },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode || 502,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      r.on("error", reject);
      r.setTimeout(120000, () => r.destroy(Error("语音服务超时")));
      if (body && body.length) r.write(body);
      r.end();
    });
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/v2/voice/")) return false;

    if (req.method === "GET" && url.pathname === "/api/v2/voice/status") {
      try {
        const r = await toPython("/health", "GET", {}, null);
        res.writeHead(r.status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(r.body);
      } catch {
        json(res, 200, { ok: false, asr: false, tts: false, error: "语音服务未启动" });
      }
      return true;
    }

    // 读取本轮引用的图片：只允许上传者本人访问（跨用户一律 404，不暴露是否存在）
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/api/v2/voice/image/")
    ) {
      const id = url.pathname.slice("/api/v2/voice/image/".length).split("/")[0];
      const user = await currentUser(req);
      if (!user) {
        json(res, 401, { error: "请先登录" });
        return true;
      }
      try {
        const img = await workspace.loadVoiceImage(user, id);
        const buf = Buffer.from(img.data, "base64");
        res.writeHead(200, {
          "Content-Type": img.mime,
          "Content-Length": buf.length,
          "Cache-Control": "private, max-age=600",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(buf);
      } catch (e) {
        json(res, e.status || 404, { error: e.message || "图片不存在" });
      }
      return true;
    }

    if (req.method !== "POST") {
      json(res, 405, { error: "方法不支持" });
      return true;
    }

    if (!(await authorized(req))) {
      if (!(allowLocal && req.socket.remoteAddress === "127.0.0.1")) {
        json(res, 401, { error: "请先登录" });
        return true;
      }
    }

    // 图片先上传：返回 image_id（真实落盘 + 归属记录），随后 /turn 只带这个 id
    if (url.pathname === "/api/v2/voice/image") {
      const user = await currentUser(req);
      if (!user) {
        json(res, 401, { error: "请先登录" });
        return true;
      }
      const image = await readRaw(req);
      if (!image.length) {
        json(res, 400, { error: "没有收到图片" });
        return true;
      }
      const ext =
        String(url.searchParams.get("ext") || "jpg")
          .toLowerCase()
          .replace(/[^a-z]/g, "") || "jpg";
      try {
        const out = await workspace.saveVoiceImage(user, {
          buffer: image,
          mime: String(req.headers["content-type"] || "").split(";")[0].trim(),
          ext,
          conversation_id: String(url.searchParams.get("conversation_id") || ""),
          // 重试/抖动去重：同一键同一用户且该图尚未被引用时复用原图，避免重复落盘
          dedup_key: url.searchParams.get("dedup_key"),
        });
        json(res, 201, out);
      } catch (e) {
        json(res, e.status || 400, { error: e.message || "上传失败" });
      }
      return true;
    }

    if (url.pathname === "/api/v2/voice/asr") {
      const audio = await readRaw(req);
      if (!audio.length) {
        json(res, 400, { error: "没有收到音频" });
        return true;
      }
      const ext = String(url.searchParams.get("ext") || "webm").replace(/[^a-z0-9]/gi, "") || "webm";
      try {
        const r = await toPython(
          `/asr?ext=${ext}`,
          "POST",
          { "Content-Type": "application/octet-stream", "Content-Length": audio.length },
          audio,
        );
        res.writeHead(r.status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(r.body);
      } catch (e) {
        json(res, 502, { error: e.message || "识别服务不可用" });
      }
      return true;
    }

    if (url.pathname === "/api/v2/voice/tts") {
      const body = await readBody(req);
      const text = String(body.text || "").trim().slice(0, 1000);
      if (!text) {
        json(res, 400, { error: "text 为空" });
        return true;
      }
      const payload = Buffer.from(
        JSON.stringify({ text, voice: String(body.voice || "") }),
        "utf8",
      );
      try {
        const r = await toPython(
          "/tts",
          "POST",
          { "Content-Type": "application/json", "Content-Length": payload.length },
          payload,
        );
        if (r.status !== 200) {
          res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" });
          res.end(r.body);
          return true;
        }
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": r.body.length,
          "Cache-Control": "public, max-age=3600",
        });
        res.end(r.body);
      } catch (e) {
        json(res, 502, { error: e.message || "语音合成不可用" });
      }
      return true;
    }

    if (url.pathname === "/api/v2/voice/turn") {
      const user = await currentUser(req);
      if (!user) {
        json(res, 401, { error: "请先登录" });
        return true;
      }
      const body = await readBody(req);
      const question = String(body.question || "").trim().slice(0, 2000);
      const requestId = String(body.request_id || "").trim();
      if (!question) {
        json(res, 400, { error: "问题为空" });
        return true;
      }
      if (!/^[\w-]{8,80}$/.test(requestId)) {
        json(res, 400, { error: "请求编号无效" });
        return true;
      }

      let created;
      try {
        created = await workspace.createVoiceTurn(user, {
          request_id: requestId,
          question,
          conversation_id: body.conversation_id || undefined,
          domain: body.domain,
          // 语音带图：先上传拿 image_id（推荐），也兼容内联 base64 的旧调用
          image: body.image,
          image_id: body.image_id,
        });
      } catch (e) {
        json(res, e.status || 400, { error: e.message || "创建失败" });
        return true;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let open = true;
      const send = (obj) => {
        if (open) res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const ac = new AbortController();
      res.on("close", () => {
        open = false;
        ac.abort();
      });

      const turnId = created.turn_id || created.turn.id;
      send({
        type: "meta",
        conversation_id: created.conversation_id,
        turn_id: turnId,
        status: "queued",
        source: "voice",
      });

      // 不再在这里直连 3B：统一编排在后台队列里生成，这里只追读并转发增量。
      // 好处：知识检索、权限、上下文、模型路由、取消语义与文字问答完全一致。
      let sent = 0;
      let lastPhase = "";
      let finalStatus = "";
      const TERMINAL = ["completed", "partial", "failed", "canceled"];
      while (open && !ac.signal.aborted) {
        const v = await workspace.voiceTurnView(user, turnId);
        if (!v) {
          send({ error: "问答不存在" });
          break;
        }
        if (v.text.length > sent) {
          send({ delta: v.text.slice(sent) });
          sent = v.text.length;
        }
        const phase =
          v.status === "generating"
            ? v.candidate_status === "generating"
              ? "generating"
              : "queued"
            : v.status;
        if (phase !== lastPhase) {
          lastPhase = phase;
          send({ type: "phase", phase, refs: v.refs });
        }
        if (TERMINAL.includes(v.status)) {
          // 终态再读一次：候选文本与状态可能相差一个落盘周期，尾部不能丢
          const fin = await workspace.voiceTurnView(user, turnId);
          if (fin && fin.text.length > sent) {
            send({ delta: fin.text.slice(sent) });
            sent = fin.text.length;
          }
          finalStatus = v.status;
          if (v.status === "failed" && fin && fin.error) send({ error: fin.error });
          break;
        }
        await sleep(120);
      }
      // 客户端先断开时不在这里取消：生成继续落库，避免误杀（与图片取消同一教训）
      send({
        done: true,
        status: finalStatus || "aborted",
        turn_id: turnId,
        aborted: ac.signal.aborted,
      });
      open = false;
      res.end();
      return true;
    }

    if (url.pathname === "/api/v2/voice/answer") {
      const body = await readBody(req);
      const question = String(body.question || "").trim().slice(0, 2000);
      if (!question) {
        json(res, 400, { error: "问题为空" });
        return true;
      }
      const role = body.role === "cloud" ? "cloud" : "local";
      const history = Array.isArray(body.history)
        ? body.history
            .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
            .slice(-8)
            .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
        : [];
      const messages = [
        {
          role: "system",
          content:
            "你是农业园区助手，正在和用户语音通话。回答必须口语化、简短（尽量 120 字以内），" +
            "不要使用 Markdown、列表、标题或表情符号，因为回答会被直接朗读。缺少必要条件时先反问一句。",
        },
        ...history,
        { role: "user", content: question },
      ];

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let open = true;
      const send = (obj) => {
        if (open) res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const ac = new AbortController();
      res.on("close", () => {
        open = false;
        ac.abort();
      });
      try {
        let started = false;
        try {
          await streamOllama(
            messages,
            (delta) => {
              started = true;
              send({ delta });
            },
            ac.signal,
          );
        } catch (e) {
          // 语音小模型不可用时退回家族模型网关
          if (!started && !ac.signal.aborted) {
            await gateway.call(
              role,
              messages,
              false,
              undefined,
              (delta) => send({ delta }),
              { signal: ac.signal },
            );
          } else if (!ac.signal.aborted) {
            throw e;
          }
        }
        send({ done: true });
      } catch (e) {
        if (!ac.signal.aborted) send({ error: e.message || "生成失败", code: e.code });
      }
      open = false;
      res.end();
      return true;
    }

    json(res, 404, { error: "接口不存在" });
    return true;
  }

  return { handle };
}
