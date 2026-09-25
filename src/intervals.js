// 纯函数区间工具：合并、求最早空闲段。
export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((iv) => iv)
    .map(([s, e]) => [s, e])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function overlaps([s1, e1], [s2, e2]) {
  return s1 < e2 && s2 < e1;
}

// 在 [from, hardEnd] 内找出长度不少于 duration 的最早空闲段；allowed 进一步限制可工作时段。
export function earliestGap(blocked, duration, from, hardEnd = Infinity, allowed = null) {
  const windows = allowed ? intersect([[from, hardEnd]], allowed) : [[from, hardEnd]];
  const busy = mergeIntervals(blocked);
  for (const [ws, we] of windows) {
    let cursor = ws;
    for (const [bs, be] of busy) {
      if (be <= cursor) continue;
      if (bs >= we) break;
      if (bs > cursor && bs - cursor >= duration) return [cursor, cursor + duration];
      cursor = Math.max(cursor, be);
      if (cursor >= we) break;
    }
    if (we - cursor >= duration) return [cursor, cursor + duration];
  }
  return null;
}

function intersect(a, b) {
  const out = [];
  for (const [s1, e1] of mergeIntervals(a)) {
    for (const [s2, e2] of mergeIntervals(b)) {
      const s = Math.max(s1, s2);
      const e = Math.min(e1, e2);
      if (s < e) out.push([s, e]);
    }
  }
  return out;
}

// 收割机班次：每日循环的工作时段，生成 [from, to] 内的允许窗口。
export function shiftWindows(shifts, from, to, dayMs = 24 * 3_600_000) {
  if (!shifts) return [[from, to]];
  const out = [];
  const dayStart = from - (from % dayMs);
  for (let day = dayStart - dayMs; day <= to; day += dayMs) {
    for (const sh of shifts) {
      const s = day + sh.start;
      const e = day + sh.end;
      if (e > from && s < to) out.push([Math.max(s, from), Math.min(e, to)]);
    }
  }
  return mergeIntervals(out);
}
