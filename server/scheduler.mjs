/**
 * 轻量调度原语：信号量（限额等待）。
 * 用于控制本地/云端模型候选并发的上限（本地 ≤2、云端 ≤2），
 * 以及全局 generate 任务并发上限。纯 JS 模块，无独立进程。
 */
export function createSemaphore(limit) {
  if (!Number.isInteger(limit) || limit < 1)
    throw Error("信号量上限须为正整数");
  let active = 0;
  const queue = [];
  function pump() {
    while (queue.length && active < limit) {
      const resolve = queue.shift();
      active += 1;
      resolve();
    }
  }
  return {
    get active() {
      return active;
    },
    get limit() {
      return limit;
    },
    /** 获取一个额度，返回一个 release 函数，用毕必须调用。 */
    async acquire() {
      if (active < limit) {
        active += 1;
        return () => {
          active -= 1;
          pump();
        };
      }
      await new Promise((resolve) => queue.push(resolve));
      return () => {
        active -= 1;
        pump();
      };
    },
  };
}
