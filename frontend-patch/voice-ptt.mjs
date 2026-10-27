// 系统提示：语音交互层当前是"点击开始 + 停顿检测自动提交"（见 dist 文案
// 「说完停顿一下，我会自动提交」）。实测该方式没有最大时长上限：连续有声（风扇/电视/说话）
// 时永远停在"请说话…"，用户无法结束 → 即"语音停止无响应"。
// 本模块把交互收敛为用户动作驱动：按住说话 → 松开提交；上滑取消；超时自动结束。
// 纯逻辑、无 DOM 依赖，便于单测；接入时只需把 pointerdown/pointerup/pointercancel/
// pointermove 事件转发进来。

export const PTT_DEFAULTS = {
  maxMs: 60_000, // 单次最长 60s：到点自动结束并提交
  minMs: 300, // 过短视为误触，提示重录，不提交
  cancelSlideUpPx: 60, // 上滑超过该距离视为取消
  warnAtMs: 50_000, // 提前 10s 提示"即将自动结束"
};

/**
 * @param {object} opts
 * @param {number} [opts.maxMs]
 * @param {number} [opts.minMs]
 * @param {number} [opts.cancelSlideUpPx]
 * @param {() => number} [opts.now] 便于测试注入时钟
 * @param {(evt: {type: string, reason?: string, elapsedMs?: number}) => void} [opts.onEvent]
 */
export function createPtt(opts = {}) {
  const cfg = { ...PTT_DEFAULTS, ...opts };
  const now = cfg.now || (() => Date.now());
  const emit = cfg.onEvent || (() => {});

  let state = "idle"; // idle | recording | done
  let startedAt = 0;
  let originY = 0;
  let slidUp = false;
  let submitted = false;
  let warned = false;

  const elapsed = () => (state === "recording" ? now() - startedAt : 0);

  function reset() {
    state = "idle";
    startedAt = 0;
    originY = 0;
    slidUp = false;
    submitted = false;
    warned = false;
  }

  return {
    get state() {
      return state;
    },
    elapsed,
    /** 按下：开始录音 */
    start(y = 0) {
      if (state === "recording") return { ok: false, reason: "already" };
      reset();
      state = "recording";
      startedAt = now();
      originY = y;
      emit({ type: "start" });
      return { ok: true };
    },
    /** 移动：上滑取消 */
    move(y) {
      if (state !== "recording") return { cancelArmed: false };
      if (originY - y >= cfg.cancelSlideUpPx) slidUp = true;
      else if (y - originY >= cfg.cancelSlideUpPx / 2) slidUp = false;
      emit({ type: "slide", cancelArmed: slidUp });
      return { cancelArmed: slidUp };
    },
    /** 松开：提交（或取消/过短） */
    end() {
      if (state !== "recording") return { action: "ignored" };
      const ms = elapsed();
      state = "done";
      if (slidUp) {
        emit({ type: "cancel", reason: "slide-up", elapsedMs: ms });
        reset();
        return { action: "cancelled", reason: "slide-up" };
      }
      if (ms < cfg.minMs) {
        emit({ type: "tooShort", elapsedMs: ms });
        reset();
        return { action: "tooShort" };
      }
      if (submitted) return { action: "ignored" }; // 双保险：同一次按压只提交一次
      submitted = true;
      emit({ type: "submit", elapsedMs: ms });
      reset();
      return { action: "submit", elapsedMs: ms };
    },
    /** 中断（切后台/来电/失焦/pointercancel）：结束并丢弃，不自动发送半段 */
    abort(reason = "interrupted") {
      if (state !== "recording") return { action: "ignored" };
      const ms = elapsed();
      state = "done";
      emit({ type: "abort", reason, elapsedMs: ms });
      reset();
      return { action: "aborted", reason, elapsedMs: ms };
    },
    /** 心跳：检查预警与最长时长（由 rAF/interval 调用） */
    tick() {
      if (state !== "recording") return { action: "idle" };
      const ms = elapsed();
      if (!warned && ms >= cfg.warnAtMs) {
        warned = true;
        emit({ type: "warn", elapsedMs: ms, inMs: cfg.maxMs - ms });
      }
      if (ms >= cfg.maxMs) {
        state = "done";
        if (submitted) return { action: "ignored" };
        submitted = true;
        emit({ type: "submit", reason: "max-duration", elapsedMs: ms });
        reset();
        return { action: "submit", reason: "max-duration", elapsedMs: ms };
      }
      return { action: "recording", elapsedMs: ms };
    },
  };
}

/**
 * 轮询策略：前端现在无条件每 3 秒拉 /conversations + /turns，任务完成后仍不停
 * （实测静置 30s 仍发 11 次）。此函数给出"是否继续 / 下次间隔"。
 */
export function pollPolicy({ turnStatus, candidates = [], attempt = 0, hidden = false }) {
  const terminal = (s) =>
    ["completed", "failed", "cancelled", "error"].includes(String(s || "").toLowerCase());
  const allTerminal = candidates.length > 0 && candidates.every((c) => terminal(c.status));
  if (terminal(turnStatus) && allTerminal) return { poll: false, delayMs: null };
  if (hidden) return { poll: false, delayMs: null }; // 页面不可见时不轮询，回到前台再补一次
  const ladder = [1000, 2000, 3000, 5000];
  return { poll: true, delayMs: ladder[Math.min(attempt, ladder.length - 1)] };
}
