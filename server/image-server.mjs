import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { digest } from "./documents.mjs";

// 尺寸白名单：固定预设，不向员工暴露任意分辨率
const SIZES = new Set([768, 1024]);
const now = () => new Date().toISOString();
const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};

// 图片任务模块：员工经青禾提交固定 FLUX 工作流，查看/取消/下载均校验归属。
// ComfyUI 只监听本机，本模块通过 127.0.0.1:8188 调用；不暴露给普通员工。
export function createImageServer({ repo, env, json, readBody }) {
  const comfyUrl = (env.IMAGE_COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
  const outputDir = env.IMAGE_OUTPUT_DIR || "/home/jingyang/agri-image/output";
  fs.mkdirSync(outputDir, { recursive: true });

  async function userFor(req) {
    const token = String(req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("agri_session="))
      ?.slice(13);
    if (!token) return null;
    const session = await repo.get("sessions", digest(token));
    if (!session || session.expires_at < Date.now()) return null;
    const u = await repo.get("users", session.owner);
    return u?.active ? u : null;
  }
  async function requireUser(req) {
    const u = await userFor(req);
    if (!u) fail("请先登录", 401);
    return u;
  }

  async function comfy(method, p, body) {
    const res = await fetch(comfyUrl + p, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {}
    if (!res.ok) fail("出图服务异常：" + (data?.error || `HTTP ${res.status}`), 502);
    return data;
  }

  // 固定 FLUX.1-schnell 原生工作流：4 步、cfg=1.0、euler/simple、batch=1
  function buildWorkflow(prompt, size, seed) {
    return {
      prompt: {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "flux1-schnell.safetensors", weight_dtype: "default" } },
        "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: "clip_l.safetensors", clip_name2: "t5xxl_fp16.safetensors", type: "flux" } },
        "3": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
        "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
        "5": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
        "6": { class_type: "EmptyLatentImage", inputs: { width: size, height: size, batch_size: 1 } },
        "7": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["6", 0], seed, steps: 4, cfg: 1.0, sampler_name: "euler", scheduler: "simple", denoise: 1.0 } },
        "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["5", 0] } },
        "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "qhe" } },
      },
      client_id: "agri-workbench",
    };
  }

  // 用 ComfyUI history 同步单个任务状态，并回写数据库
  async function syncTask(t) {
    if (!t.comfy_prompt_id || ["completed", "failed", "cancelled"].includes(t.status))
      return t;
    try {
      const d = await comfy("GET", "/history/" + t.comfy_prompt_id);
      const h = d?.[t.comfy_prompt_id];
      if (!h) return t; // 仍在排队或未知
      const st = h.status || {};
      if (st.completed) {
        let filename = "";
        const outs = h.outputs || {};
        for (const v of Object.values(outs)) {
          const imgs = v.images || [];
          if (imgs.length) {
            const im = imgs[0];
            filename = [im.subfolder, im.filename].filter(Boolean).join("/");
            break;
          }
        }
        const rec = { ...t, status: "completed", filename, completed_at: now(), error: "" };
        await repo.put("image_jobs", rec);
        return rec;
      }
      if (st.status_str && st.status_str !== "success") {
        const rec = { ...t, status: "failed", error: st.status_str || "failed", completed_at: now() };
        await repo.put("image_jobs", rec);
        return rec;
      }
      if (t.status === "queued") {
        const rec = { ...t, status: "running" };
        await repo.put("image_jobs", rec);
        return rec;
      }
      return t;
    } catch {
      return t; // ComfyUI 暂不可达时不误判失败
    }
  }

  // 创建并提交一个图片任务（供 HTTP 路由与问答配图复用）。
  // u 需含 id/tenant/username；返回最终 task（含 comfy_prompt_id 或 failed 状态）。
  async function createTask(u, { prompt, size }) {
    const p = String(prompt || "").trim();
    if (!p) fail("提示词不能为空");
    if (p.length > 2000) fail("提示词过长（最多 2000 字符）");
    if (!SIZES.has(size)) fail("尺寸仅支持 768 或 1024");
    const seed = Math.floor(Math.random() * 1_000_000) + 1;
    const task = {
      id: randomUUID(),
      owner: u.id,
      tenant: u.tenant || "park",
      domain: "image",
      user_id: u.id,
      username: u.username || u.name || "",
      prompt: p,
      width: size,
      height: size,
      seed,
      status: "queued",
      created_at: now(),
      comfy_prompt_id: null,
      filename: "",
      error: "",
      completed_at: "",
    };
    await repo.put("image_jobs", task); // 先落库，任务不丢
    try {
      const r = await comfy("POST", "/prompt", buildWorkflow(p, size, seed));
      const pid = r?.prompt_id;
      if (!pid) fail("出图服务未返回任务号", 502);
      const rec = { ...task, comfy_prompt_id: pid };
      await repo.put("image_jobs", rec);
      return rec;
    } catch (e) {
      const rec = { ...task, status: "failed", error: e.message, completed_at: now() };
      await repo.put("image_jobs", rec);
      return rec;
    }
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/v2/")) return false;
    const routePath = url.pathname.slice(7),
      method = req.method;
    if (method !== "GET" && req.headers["x-workbench"] !== "1")
      fail("缺少请求校验头", 403);
    const body = () => readBody(req, 1_000_000);
    const send = (v, status = 200) => {
      json(res, status, v);
      return true;
    };

    if (routePath === "/images/generate" && method === "POST") {
      const u = await requireUser(req);
      const b = await body();
      return send({ task: await createTask(u, { prompt: b.prompt, size: Number(b.size) }) });
    }

    if (routePath === "/images/tasks" && method === "GET") {
      const u = await requireUser(req);
      const items = await repo.list("image_jobs", { owner: u.id });
      return send({ items });
    }

    const m = routePath.match(/^\/images\/tasks\/([^/]+)$/);
    if (m && method === "GET") {
      const u = await requireUser(req);
      const t = await repo.get("image_jobs", m[1]);
      if (!t) fail("任务不存在", 404);
      if (t.user_id !== u.id) fail("无权查看", 403);
      return send({ task: await syncTask(t) });
    }

    const mc = routePath.match(/^\/images\/tasks\/([^/]+)\/cancel$/);
    if (mc && method === "POST") {
      const u = await requireUser(req);
      const t = await repo.get("image_jobs", mc[1]);
      if (!t) fail("任务不存在", 404);
      if (t.user_id !== u.id) fail("无权操作", 403);
      let cancelled = false;
      if (t.comfy_prompt_id && ["queued", "running"].includes(t.status)) {
        try {
          await comfy("POST", "/api/jobs/" + t.comfy_prompt_id + "/cancel", {});
          cancelled = true;
        } catch {}
      }
      const rec = {
        ...t,
        status: "cancelled",
        completed_at: now(),
        error: cancelled ? "" : "取消失败或任务已完成",
      };
      await repo.put("image_jobs", rec);
      return send({ task: rec, cancelled });
    }

    const mf = routePath.match(/^\/images\/([^/]+)\/file$/);
    if (mf && method === "GET") {
      const u = await requireUser(req);
      const t = await repo.get("image_jobs", mf[1]);
      if (!t) fail("任务不存在", 404);
      if (t.user_id !== u.id) fail("无权查看", 403);
      if (t.status !== "completed" || !t.filename) fail("图片尚未生成", 404);
      const file = path.join(outputDir, t.filename);
      if (!fs.existsSync(file)) fail("图片文件缺失", 404);
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": data.length,
        "Content-Disposition": `inline; filename="${path.basename(t.filename)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(data);
      return true;
    }

    return false;
  }

  return { handle, createTask };
}
