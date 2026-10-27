/**
 * 语音会话守卫（候选补丁，纯逻辑、无 DOM，便于单测）
 *
 * 背景：线上 dist（2026-10-26 12:05 构建）已实现「上传优先 + 按住说话」，
 * 但夜间要修的三类问题都是**时序**问题，分散在 DOM 事件里改不稳：
 *   1. 打断：新一轮开始时，旧一轮的播报与请求必须一起撤销（否则旧音频继续念、
 *      旧 SSE 继续写，界面出现两条答案叠加；且录音会把 TTS 自己收进去形成自激）
 *   2. 重复提交：网络抖动/用户连点会产生第二条 turn（服务端 request_id 幂等能兜住
 *      一半，但本地仍会开两条流、播两遍）
 *   3. 上传进度造假：只画了缩略图就说"已上传"，实际服务端还没有 image_id，
 *      后面带图提问会拿着空 id 去问
 *
 * 本模块把这三件事收敛成一个状态机，接入方只需转发事件与回调，
 * 所有判定都能在主机上单测（不依赖浏览器、不依赖真实音频）。
 *
 * 【本补丁不改动任何线上文件】交付形态是候选包 + 单测 + 明早的手机验收步骤。
 */

export const GUARD_DEFAULTS = {
  /** 从"开始说"到"服务端确认"的兜底超时（ms） */
  requestTimeoutMs: 30_000,
  /** 上传兜底超时（ms）：只影响本地提示，不影响服务端真实结果 */
  uploadTimeoutMs: 30_000,
  /** 打断后等待播报真正停下来的宽限（ms），超时也要继续发新请求 */
  interruptGraceMs: 250,
};

export function createVoiceGuard(opts = {}) {
  const cfg = { ...GUARD_DEFAULTS, ...opts };
  const now = cfg.now || (() => Date.now());
  const emit = cfg.onEvent || (() => {});

  let phase = "idle"; // idle | interrupting | awaiting_turn | streaming | speaking | done | error
  let active = null; // { request_id, startedAt, controller, image_id }
  let uploads = new Map(); // localId -> { state, image_id, startedAt, bytes }

  function setPhase(p, extra = {}) {
    phase = p;
    emit({ type: "phase", phase: p, ...extra });
  }

  return {
    get phase() {
      return phase;
    },
    get activeRequestId() {
      return active ? active.request_id : "";
    },
    /** 已确认上传的图片（有服务端 image_id 才算数） */
    confirmedUploads() {
      return [...uploads.values()]
        .filter((u) => u.state === "uploaded" && u.image_id)
        .map((u) => ({ localId: u.localId, image_id: u.image_id }));
    },
    uploads,

    /**
     * 本地选完图：只是预览，状态必须是 preview，不允许当成已上传
     */
    pickImage(localId, bytes = 0) {
      uploads.set(localId, {
        localId,
        state: "preview",
        image_id: "",
        startedAt: 0,
        bytes,
      });
      emit({ type: "upload", localId, state: "preview" });
      return { ok: true, state: "preview" };
    },

    /** 真正开始上传：进度只能来自传输事件，服务端 201 才算 uploaded */
    startUpload(localId) {
      const u = uploads.get(localId);
      if (!u) return { ok: false, reason: "no-image" };
      u.state = "uploading";
      u.startedAt = now();
      u.image_id = "";
      emit({ type: "upload", localId, state: "uploading" });
      return { ok: true };
    },

    /**
     * 服务端确认：必须带 image_id，否则视为未确认（缩略图不是上传成功）
     */
    confirmUpload(localId, image_id) {
      const u = uploads.get(localId);
      if (!u) return { ok: false, reason: "no-image" };
      const id = String(image_id || "").trim();
      if (!id) {
        u.state = "failed";
        u.error = "服务端未返回图片编号";
        emit({ type: "upload", localId, state: "failed", error: u.error });
        return { ok: false, reason: "missing-image-id" };
      }
      u.state = "uploaded";
      u.image_id = id;
      emit({ type: "upload", localId, state: "uploaded", image_id: id });
      return { ok: true, image_id: id };
    },

    failUpload(localId, error = "上传失败") {
      const u = uploads.get(localId);
      if (!u) return { ok: false, reason: "no-image" };
      u.state = "failed";
      u.error = String(error);
      emit({ type: "upload", localId, state: "failed", error: u.error });
      return { ok: true };
    },

    removeUpload(localId) {
      uploads.delete(localId);
      emit({ type: "upload", localId, state: "removed" });
      return { ok: true };
    },

    /**
     * 发起新一轮：先打断旧的（停播报 + 撤旧请求），再发新的。
     * 同一 request_id 在途时直接复用，不重复提交。
     */
    async ask({ request_id, image_local_id, question, send }) {
      const rid = String(request_id || "").trim();
      if (!rid) return { ok: false, reason: "missing-request-id" };
      if (active && active.request_id === rid)
        return { ok: true, reused: true, request_id: rid };

      // 1) 打断：先停播报再撤请求，顺序反了会把自己的 TTS 收进录音里
      if (active) {
        setPhase("interrupting", { request_id: active.request_id });
        emit({ type: "interrupt", request_id: active.request_id, target: "tts" });
        if (cfg.stopSpeaking) await cfg.stopSpeaking();
        emit({ type: "interrupt", request_id: active.request_id, target: "request" });
        if (active.controller) active.controller.abort();
        if (cfg.cancelRequest) {
          try {
            await cfg.cancelRequest(active.request_id);
          } catch {
            /* 取消失败不阻塞新请求：服务端 request_id 幂等会兜住 */
          }
        }
        active = null;
      }

      const u = image_local_id ? uploads.get(image_local_id) : null;
      if (image_local_id) {
        if (!u || u.state !== "uploaded" || !u.image_id)
          return {
            ok: false,
            reason: "image-not-confirmed",
            message: "图片还没上传成功，不能带图提问",
          };
      }

      const controller = new AbortController();
      active = { request_id: rid, startedAt: now(), controller, image_id: u ? u.image_id : "" };
      setPhase("awaiting_turn", { request_id: rid });
      try {
        const res = await send({
          request_id: rid,
          question,
          image_id: active.image_id,
          signal: controller.signal,
        });
        if (active && active.request_id !== rid) return { ok: false, reason: "superseded" };
        setPhase("streaming", { request_id: rid });
        return { ok: true, request_id: rid, res };
      } catch (e) {
        if (active && active.request_id === rid) {
          active = null;
          setPhase("error", { request_id: rid, error: e && e.message });
        }
        return { ok: false, reason: "failed", error: e && e.message };
      }
    },

    /** 文本收齐 → 开始播报（播报期间不得启动录音，否则自激） */
    beginSpeaking() {
      if (!active) return { ok: false, reason: "no-active" };
      setPhase("speaking", { request_id: active.request_id });
      return { ok: true };
    },

    /** 播报结束/被打断：回到 idle，允许下一轮 */
    finishSpeaking() {
      if (phase === "speaking") setPhase("done");
      if (active) active = null;
      return { ok: true };
    },

    /**
     * 录音请求：播报中不允许开始（避免扬声器声音被收进去）
     */
    requestMic() {
      if (phase === "speaking" || phase === "interrupting")
        return { ok: false, reason: "speaking", message: "正在播报，请稍后再说" };
      return { ok: true };
    },

    /** 权限被拒/用户取消/切后台/断线：统一收敛到可恢复状态 */
    abort(reason = "user") {
      if (active && active.controller) active.controller.abort();
      const rid = active ? active.request_id : "";
      active = null;
      setPhase("idle", { reason, request_id: rid });
      emit({ type: "abort", reason, request_id: rid });
      return { ok: true, request_id: rid };
    },

    /** 断线恢复：只把状态收回 idle，不补发任何请求（要不要重发由用户决定） */
    reconnect() {
      const rid = active ? active.request_id : "";
      active = null;
      setPhase("idle", { reason: "reconnect", request_id: rid });
      emit({ type: "reconnect", request_id: rid });
      return { ok: true, request_id: rid, needsResend: Boolean(rid) };
    },

    elapsed() {
      return active ? now() - active.startedAt : 0;
    },
    timedOut() {
      return Boolean(active) && now() - active.startedAt > cfg.requestTimeoutMs;
    },
  };
}
