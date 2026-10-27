/**
 * 轻量调度原语：信号量（限额等待）与资源限流器。
 * 用于控制模型调用的并发上限（本地/云端各 ≤2，按实际上游资源归组）。
 * acquire 支持外部取消信号；取消时立即拒绝并从等待队列移除，不阻塞释放。
 */
export function createSemaphore(limit) {
  if (!Number.isInteger(limit) || limit < 1)
    throw Error("信号量上限须为正整数");
  let active = 0;
  const queue = [];
  function pump() {
    while (queue.length && active < limit) {
      const item = queue.shift();
      if (item.signal?.aborted) {
        // 已取消的等待项不再占用名额
        if (!item.settled) {
          item.settled = true;
          item.reject(Object.assign(Error("已取消"), { code: "canceled" }));
        }
        continue;
      }
      active += 1;
      if (!item.settled) {
        item.settled = true;
        item.resolve(() => {
          active -= 1;
          pump();
        });
      }
    }
  }
  return {
    get active() {
      return active;
    },
    get limit() {
      return limit;
    },
    get waiting() {
      return queue.length;
    },
    /** 获取一个额度，返回 release 函数；可传 AbortSignal 以便取消等待。 */
    async acquire(signal) {
      if (signal?.aborted)
        throw Object.assign(Error("已取消"), { code: "canceled" });
      if (active < limit) {
        active += 1;
        return () => {
          active -= 1;
          pump();
        };
      }
      return await new Promise((resolve, reject) => {
        const item = {
          signal,
          settled: false,
          resolve: (release) => resolve(release),
          reject,
        };
        queue.push(item);
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              const idx = queue.indexOf(item);
              if (idx >= 0) queue.splice(idx, 1);
              if (!item.settled) {
                item.settled = true;
                reject(Object.assign(Error("已取消"), { code: "canceled" }));
              }
            },
            { once: true },
          );
        }
      });
    },
  };
}

/** 按资源键维护一组信号量，同一上游资源共享同一额度。 */
export function createResourceLimiter() {
  const sems = new Map();
  return {
    /** key 标识实际上游（如 base_url）；同一 key 共享 limit。 */
    async acquire(key, limit, signal) {
      let s = sems.get(key);
      if (!s) {
        s = createSemaphore(limit);
        sems.set(key, s);
      }
      return s.acquire(signal);
    },
    active(key, limit) {
      const s = sems.get(key);
      if (!s) return 0;
      return s.active;
    },
    waiting(key, limit) {
      const s = sems.get(key);
      if (!s) return 0;
      return s.waiting;
    },
  };
}
