import { earliestGap, shiftWindows, mergeIntervals } from './intervals.js';
import { HOUR } from './clock.js';

const DAY = 24 * HOUR;
export const PLAN_HORIZON = 30 * DAY;

// 稻谷安全储存含水率上限（%）。
export const SAFE_MOISTURE = 13.5;

// 作业时长估算（实测数据到达后由事件修正）。
export function harvestDurationMs(yieldKg) {
  // 收割机约 1200 公斤/小时，最少 40 分钟。
  return Math.max(40 * 60_000, Math.round((yieldKg / 1200) * HOUR));
}
export function transportDurationMs() {
  return 30 * 60_000; // 单轨区段单程含装卸
}
export function dryDurationMs(moistureIntake) {
  // 连续烘干：基础 3 小时，每高 1 个水分点加 40 分钟，必须一次连续完成。
  const points = Math.max(0, (moistureIntake ?? 22) - SAFE_MOISTURE);
  return 3 * HOUR + Math.round(points * 40 * 60_000);
}

// 资源在给定时刻之后不可用的区间：已排定/进行中占用、停机、跨村调机、降雨停工。
export function blockedIntervals(state, eq, stage, from) {
  const blocked = [];
  for (const b of state.bookings.values()) {
    if (b.resourceId !== eq.id) continue;
    if (b.status === 'booked' || b.status === 'running') {
      blocked.push([b.start, b.end]);
    } else if (b.status === 'interrupted') {
      blocked.push([b.start, b.interruptedAt ?? b.end]); // 中断即释放
    }
  }
  for (const d of eq.downtime) blocked.push([d.start, d.end ?? Infinity]);
  for (const t of eq.transfers) blocked.push([t.start, t.end]);
  for (const r of state.rain) {
    if (r.stages.includes(stage)) blocked.push([r.start, r.end ?? Infinity]);
  }
  return mergeIntervals(blocked.filter(([s, e]) => e > from));
}

// 预约自身的硬约束（不满足则该预约受阻，不占用资源、不堵住后续预约）。
export function attributeViolation(state, booking, eq) {
  const plot = state.plots.get(booking.plotId);
  if (eq.kind === 'harvester') {
    if (!plot.accessible.includes(eq.id)) return '设备不可达该地块';
    if (eq.maxSlope !== null && plot.slope > eq.maxSlope) {
      return `坡度 ${plot.slope}° 超过设备上限 ${eq.maxSlope}°`;
    }
  }
  if ((eq.kind === 'monorail' || eq.kind === 'dryer') && eq.capacityKg !== null) {
    const kg = booking.tripKg
      ?? (booking.stage === 'dry'
        ? (state.batches.get(booking.batchId)?.weightKg ?? plot.yieldKg)
        : plot.yieldKg);
    if (kg > eq.capacityKg) return `载重 ${kg}kg 超过${eq.kind === 'dryer' ? '仓' : '区段'}上限 ${eq.capacityKg}kg`;
  }
  return null;
}

// 为单个预约寻找最早可行时段。
// 返回 {start,end,late?}；或 {reason, blocker:'self'}（自身条件不满足，可被后续越过）。
export function propose(state, booking, now) {
  const eq = state.equipment.get(booking.resourceId);
  const selfReason = attributeViolation(state, booking, eq);
  if (selfReason) return { reason: selfReason, blocker: 'self' };
  const batch = booking.batchId ? state.batches.get(booking.batchId) : null;
  if (booking.stage === 'dry' && batch?.needRecheck) {
    return { reason: '烘干中断后等待品质复测水分', blocker: 'self' };
  }

  // 交接链：按上一段的（计划）完成时间推算最早可开工，整条链一次排定。
  const ready = earliestReady(state, booking, now);
  const plot = state.plots.get(booking.plotId);
  const deadline = plot?.deadline ?? Infinity;
  const duration = booking.remainingMs ?? booking.durationMs;

  const allowed = eq.kind === 'harvester' ? shiftWindows(eq.shifts, ready, ready + PLAN_HORIZON) : null;
  const gap = earliestGap(
    blockedIntervals(state, eq, booking.stage, ready),
    duration,
    ready,
    ready + PLAN_HORIZON,
    allowed
  );
  if (!gap) return { reason: '规划视界内无可用时段', blocker: 'resource' };
  const result = { start: gap[0], end: gap[1] };
  if (gap[1] > deadline) {
    result.late = true;
    result.reason = `预计完成 ${gap[1]} 晚于最晚完成时间 ${deadline}`;
  }
  return result;
}

// 沿交接链求最早可开工时间：已完成取实测完成时刻，否则取上一段计划完工时刻。
function earliestReady(state, booking, now, seen = new Set()) {
  if (!booking.dependsOn) return now;
  if (seen.has(booking.id)) return now;
  seen.add(booking.id);
  const dep = state.bookings.get(booking.dependsOn);
  if (!dep || dep.status === 'cancelled') return now;
  if (dep.status === 'done') return Math.max(now, dep.completedAt);
  if (dep.end !== null && dep.end !== undefined) return Math.max(now, dep.end);
  return earliestReady(state, dep, now, seen);
}
