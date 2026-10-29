// 请求状态机：把「谁在等、等的是什么、什么时候能放开」从模板的 busy 里拆出来
//
// 事故背景：公网链路偶发几十秒无响应时，页面只有一个全局 busy：
//   - 发送请求挂着 → busy 一直为 true
//   - 停止按钮 :disabled="busy" 且 cancelTurn 走 act()（act 开头 if (busy) return）
//     → 用户最想取消的时候恰好按不了
//   - 轮询 if (busy) return → 生成期间界面完全不刷新，看起来像死机
//   - 超时后 busy 才放开，但服务端可能早就建好了轮次，用户再发就是第二条
//
// 这里把提交、取消、轮询的行为收敛成纯逻辑，便于用故障注入单测：
//   begin → SENDING；明确失败（4xx）→ IDLE 且丢弃 draft；
//   超时/断网（状态不明）→ UNCONFIRMED，保留同一 request_id 供对账；
//   切会话（epoch 变）→ 作废在途提交，迟到响应既不填新会话也不解锁新请求。

export const SEND = {
  IDLE: "idle",
  SENDING: "sending",
  UNCONFIRMED: "unconfirmed",
};

// 超时都在这里改：启动探测要短（用户在看白屏），提交可以长一点（服务端要建轮次）
export const TIMEOUTS = {
  boot: 15000,
  send: 20000,
  reconcile: 12000,
  cancel: 15000,
  // 后台任务清单是轻量只读查询；给短一点，慢网时不占住轮询节拍
  poll: 8000,
};

const MAX_POLL_MS = 30000;
const BASE_POLL_MS = 3000;

/**
 * 轮询间隔：连续失败按 3s→6s→12s→24s→30s 退避，成功后由调用方传 0 清零。
 * 不加重试上限，只拉长间隔——弱网下宁可慢，也不要每 3 秒堆一堆挂起请求。
 */
export function nextPollDelay(fails, { base = BASE_POLL_MS, max = MAX_POLL_MS } = {}) {
  const n = Math.max(0, Math.min(Number(fails) || 0, 5));
  return Math.min(max, base * Math.pow(2, n));
}

/**
 * 这个错误是不是「服务端明确拒绝」。
 * 只有 4xx（且不是 408/429 这类“可能没处理”）才代表**一定没有建轮次**，
 * 才能安全放开锁并丢弃 draft；超时、断网、5xx 都属于状态不明。
 */
export function isDefiniteFailure(e) {
  const status = Number((e && e.status) || 0);
  if (!status) return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * 取消能不能点：只看这一轮的状态和它自己有没有在取消中，与全局 busy 无关。
 * 生成中 → 可点；同一轮正在取消 → 期间禁用（防连点）；其它轮次的取消请求不影响它。
 */
export function cancelEnabled({ status, cancelingId, turnId }) {
  if (status !== "generating") return false;
  return !(cancelingId && cancelingId === turnId);
}

/**
 * 轮询调度器：保证「同一时刻只有一个轮询请求在飞」，失败按 nextPollDelay 退避。
 * 以前是 setInterval(poll, 3000) + if (busy) return：
 *   - 弱网时上一发还没回来，下一拍照样发，请求越堆越多
 *   - 生成中干脆全停，界面完全不刷新
 * 这里用「上一发回来才安排下一拍」替代固定节拍。
 */
export function createPollScheduler({
  run,
  delayFor = (fails) => nextPollDelay(fails),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  onError,
} = {}) {
  let fails = 0;
  let inFlight = false;
  let stopped = true;
  let handle = null;

  const schedule = () => {
    if (stopped) return;
    handle = setTimer(tick, delayFor(fails));
  };

  async function tick() {
    if (stopped) return;
    // 上一发还没回来：跳过这一拍。它回来时会自己安排下一拍，不会漏拍。
    if (inFlight) return;
    inFlight = true;
    try {
      await run();
      fails = 0;
    } catch (e) {
      fails += 1;
      if (onError) onError(e, fails);
    } finally {
      inFlight = false;
    }
    schedule();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (handle) {
        clearTimer(handle);
        handle = null;
      }
    },
    pause() {
      stopped = true;
      if (handle) {
        clearTimer(handle);
        handle = null;
      }
    },
    resume() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    tick,
    get fails() {
      return fails;
    },
    get inflight() {
      return inFlight;
    },
  };
}

/**
 * 提交跟踪器。onChange 每次状态变化回调一次（组件用它同步 ref）。
 * 返回的 token 是这一次提交的凭证：迟到的响应带着旧 token 回来时会被判 stale。
 */
export function createSendTracker({ onChange } = {}) {
  const state = {
    phase: SEND.IDLE,
    token: 0,
    draft: null,
    startEpoch: 0,
    attempts: 0,
    lastError: "",
  };
  const emit = () => {
    if (onChange) onChange({ ...state });
  };
  const owns = (token, epoch) => token === state.token && epoch === state.startEpoch;

  return {
    get state() {
      return { ...state };
    },
    get phase() {
      return state.phase;
    },
    owns,
    /** 开始一次提交。epoch 是当前会话代号，切换会话会 +1。 */
    begin(draft, epoch) {
      state.token += 1;
      state.phase = SEND.SENDING;
      state.draft = draft;
      state.startEpoch = epoch;
      state.attempts = 1;
      state.lastError = "";
      emit();
      return state.token;
    },
    /** 状态不明（超时/断网）：保留 draft 与 request_id，等对账。 */
    markUnconfirmed(token, epoch, message) {
      if (!owns(token, epoch)) return "stale";
      state.phase = SEND.UNCONFIRMED;
      state.attempts += 1;
      state.lastError = message || "";
      emit();
      return "unconfirmed";
    },
    /** 拿到服务端轮次（或 duplicate 回执）：放开锁并丢弃 draft。 */
    confirm(token, epoch) {
      if (!owns(token, epoch)) return "stale";
      state.phase = SEND.IDLE;
      state.draft = null;
      state.lastError = "";
      emit();
      return "confirmed";
    },
    /** 明确的业务失败：不会建轮次，可以安全放开并丢弃 draft。 */
    fail(token, epoch) {
      if (!owns(token, epoch)) return "stale";
      state.phase = SEND.IDLE;
      state.draft = null;
      emit();
      return "failed";
    },
    /** 切会话/新建会话：作废在途提交，迟到响应一律 stale。 */
    reset(epoch) {
      state.token += 1;
      state.phase = SEND.IDLE;
      state.draft = null;
      state.startEpoch = epoch;
      state.lastError = "";
      emit();
    },
  };
}
