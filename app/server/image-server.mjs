import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { digest } from "./documents.mjs";

// 尺寸白名单：固定预设，不向员工暴露任意分辨率
const SIZES = new Set([768, 1024]);
// 出图任务最长存活：超过即判失败，避免 ComfyUI 丢失任务时永久"排队中"
const STALE_TASK_MS = 15 * 60 * 1000;
// 对账与调用的边界：列表接口必须"快且不放大"，否则前端每 3s 轮询会把压力传给 ComfyUI
const COMFY_TIMEOUT_MS = 30_000; // 创建任务（POST /prompt）单次上限
const SYNC_QUERY_TIMEOUT_MS = 1_200; // 列表对账单次查询上限
const SYNC_MAX_PER_REQ = 5; // 单次列表最多对账几个任务
const CREATE_DEDUPE_MS = 10_000; // 同 prompt+尺寸 10s 内复用（防双击/连点产生多个任务）
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

  async function comfy(method, p, body, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs) || COMFY_TIMEOUT_MS;
    let res;
    try {
      res = await fetch(comfyUrl + p, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // 老运行时没有 AbortSignal.timeout（Node < 17.3 / 浏览器 < Chrome 103）：
        // 退化成没有超时保护，也不要抛 "is not a function"
        signal:
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(timeoutMs)
            : undefined,
      });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw Object.assign(Error(timedOut ? "出图服务超时" : "出图服务不可达"), {
        code: timedOut ? "timeout" : "network",
      });
    }
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

  // 对账轮转游标：跨请求推进，避免活跃任务多时只有前几个被反复对账
  let syncCursor = 0;

  // 终态不可被旧结果覆盖：并发/迟到的对账结果不得回滚已完成或已失败的任务
  async function putIfNotTerminal(rec) {
    const cur = await repo.get("image_jobs", rec.id);
    if (cur && ["completed", "failed", "cancelled"].includes(cur.status)) return cur;
    await repo.put("image_jobs", rec);
    return rec;
  }

  // 并发幂等：同一任务在多个请求里同时需要同步时，只查一次 ComfyUI、只写一次库
  const syncInflight = new Map();
  function syncTask(t) {
    if (!t.comfy_prompt_id || ["completed", "failed", "cancelled"].includes(t.status))
      return Promise.resolve(t);
    const inflight = syncInflight.get(t.id);
    if (inflight) return inflight;
    const task = syncTaskOnce(t).finally(() => syncInflight.delete(t.id));
    syncInflight.set(t.id, task);
    return task;
  }

  // 用 ComfyUI history 同步单个任务状态，并回写数据库
  async function syncTaskOnce(t) {
    try {
      const d = await comfy("GET", "/history/" + t.comfy_prompt_id, undefined, {
        timeoutMs: SYNC_QUERY_TIMEOUT_MS,
      });
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
        return putIfNotTerminal(rec);
      }
      if (st.status_str && st.status_str !== "success") {
        const rec = { ...t, status: "failed", error: st.status_str || "failed", completed_at: now() };
        return putIfNotTerminal(rec);
      }
      if (t.status === "queued") {
        const rec = { ...t, status: "running" };
        return putIfNotTerminal(rec);
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
    // 幂等：同一用户、同 prompt、同尺寸，10s 内已有进行中的任务 → 直接复用（防双击）
    const recent = (await repo.list("image_jobs", { owner: u.id }))
      .filter(
        (t) =>
          t.prompt === p &&
          t.width === size &&
          t.height === size &&
          ["queued", "running"].includes(t.status) &&
          Date.now() - Date.parse(t.created_at || "") < CREATE_DEDUPE_MS,
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (recent) return { ...recent, deduped: true };

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
      // 前端只轮询列表接口；此处若不与 ComfyUI 对账，任务会永远停在上次写入的状态。
      // 实测：ComfyUI 6.08s 出图完成、队列已空，平台任务仍为 queued，页面一直"排队中"。
      // 限流：单次请求最多对账 SYNC_MAX_PER_REQ 个；每个查询 SYNC_QUERY_TIMEOUT_MS 超时；
      // 整体用 allSettled，任何一个失败都不影响列表返回（前端 3s 一轮，不能放大成风暴）
      // 公平性：不能用固定切片（否则永远只对账前 N 个，后面的任务被饿死——已实测 5 轮只覆盖 5/12）。
      // 用轮转游标，保证多轮轮询覆盖到全部活跃任务。
      const activeAll = items.filter(
        (t) => t.comfy_prompt_id && ["queued", "running"].includes(t.status),
      );
      const take = Math.min(SYNC_MAX_PER_REQ, activeAll.length);
      const active = activeAll.length
        ? Array.from({ length: take }, (_, k) => activeAll[(syncCursor + k) % activeAll.length])
        : [];
      if (activeAll.length) syncCursor = (syncCursor + take) % activeAll.length;
      if (active.length) {
        const settled = await Promise.allSettled(active.map((t) => syncTask(t)));
        const byId = new Map();
        for (const r of settled) if (r.status === "fulfilled" && r.value) byId.set(r.value.id, r.value);
        for (let i = 0; i < items.length; i += 1)
          items[i] = byId.get(items[i].id) || items[i];
      }
      // 兜底：ComfyUI 重启/清库导致任务号丢失时，不能永久 queued
      for (let i = 0; i < items.length; i += 1) {
        const t = items[i];
        if (!["queued", "running"].includes(t.status)) continue;
        const created = Date.parse(t.created_at || "");
        if (Number.isFinite(created) && Date.now() - created > STALE_TASK_MS) {
          // 后台任务处置：先尝试把 ComfyUI 里可能还在跑的任务删掉，避免白占显存；
          // 取消失败不影响判定（可能已经跑完或已被清理）
          let cancelAttempted = false;
          let cancelOk = false;
          if (t.comfy_prompt_id) {
            cancelAttempted = true;
            try {
              await comfy("POST", "/queue", { delete: [t.comfy_prompt_id] });
              cancelOk = true;
            } catch {}
          }
          const rec = {
            ...t,
            status: "failed",
            error: "出图超时（服务端未返回结果），请重试",
            completed_at: now(),
            cancel_attempted: cancelAttempted,
            cancel_ok: cancelOk,
          };
          const saved = await putIfNotTerminal(rec);
          items[i] = saved;
        }
      }
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

      // 1) 已是终态：绝不"假取消"。已完成的任务被打成 cancelled 会让用户以为图没了。
      if (["completed", "failed", "cancelled"].includes(t.status))
        return send({ task: t, cancelled: false, reason: "already_finished" });

      // 2) 只按单个 prompt 删除排队项，绝不使用全局 /interrupt（会打断别人的任务）
      let removed = false;
      let cancelError = "";
      if (!t.comfy_prompt_id) {
        cancelError = "任务尚未提交到出图服务";
      } else {
        try {
          await comfy("POST", "/queue", { delete: [t.comfy_prompt_id] });
          removed = true;
        } catch (e) {
          cancelError = e.message || "取消失败";
        }
      }

      // 3) 删除请求成功不代表真的停了：正在采样中的任务不会被 delete 影响，
      //    必须回查队列，确认真实状态，避免"显示已取消、其实还在跑"。
      if (removed) {
        let stillRunning = false;
        try {
          const q = await comfy("GET", "/queue");
          const ids = [
            ...(q?.queue_running || []).map((x) => x?.[1]),
            ...(q?.queue_pending || []).map((x) => x?.[1]),
          ].filter(Boolean);
          stillRunning = ids.includes(t.comfy_prompt_id);
        } catch {
          stillRunning = true; // 查不到就不敢宣称已取消
        }
        if (stillRunning) {
          removed = false;
          cancelError = "任务已开始生成，无法中断（不执行全局中断以免影响其他任务）";
        }
      }

      if (removed) {
        const rec = {
          ...t,
          status: "cancelled",
          completed_at: now(),
          error: "",
          cancel_attempted: true,
          cancel_ok: true,
        };
        return send({ task: await putIfNotTerminal(rec), cancelled: true });
      }

      // 4) 取消失败：保持真实状态（queued/running），只记录取消尝试，页面照实展示
      const rec = {
        ...t,
        cancel_attempted: true,
        cancel_ok: false,
        cancel_error: cancelError,
      };
      await repo.put("image_jobs", rec);
      return send({ task: rec, cancelled: false, reason: "cancel_failed", error: cancelError });
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
        // 同一任务 id 的 filename 与图片内容固定不变，允许浏览器缓存避免重复下载导致闪屏
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(data);
      return true;
    }

    return false;
  }

  return { handle, createTask };
}
