// poll 唤醒器：没有长连接、也没有门铃文件时使用。
// 不另起定时器。间隔就是 wait() 在每轮扫表之后睡 pollSec（默认 45 秒），
// 与原来内核里的等待循环同一套时钟——执行任务的那一段不会被 poll 打断。
// 扫表期间若已经置了唤醒标志，这里不会清掉，最多再睡 1 秒就能看见（ECHO-004）。

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export function createPollWaker(cfg, opts = {}) {
  return new PollWaker(cfg, opts);
}

class PollWaker {
  constructor(cfg, { onWake, log } = {}) {
    this.mode = "poll";
    this.cfg = cfg ?? {};
    this.onWake = onWake;
    this.log = log ?? (() => {});
    this._stopped = false;
  }

  start(onWake) {
    if (typeof onWake === "function") this.onWake = onWake;
    this._stopped = false;
  }

  stop() {
    this._stopped = true;
  }

  // 不清除唤醒标志。isAwake 由调用方提供（内核的 _wakeFlag）。
  // capMs 是调用方的额外上限，只能缩短不能拉长。
  async wait(isAwake, { capMs } = {}) {
    const extraCap = Number.isFinite(capMs) && capMs > 0 ? capMs : Infinity;
    const maxWait = Math.min(extraCap, this.cfg.pollSec * 1000);
    let waited = 0;
    while (waited < maxWait) {
      if (this._stopped) return;
      await sleep(1000);
      waited += 1000;
      if (this._stopped) return;
      if (isAwake?.()) {
        this.log("event: waking");
        return;
      }
    }
  }
}
