// 可替换的时钟：生产环境用系统时间，测试可固定/快进。
export function createClock(start = Date.now()) {
  let now = start;
  return {
    now: () => now,
    set: (t) => {
      now = t;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
