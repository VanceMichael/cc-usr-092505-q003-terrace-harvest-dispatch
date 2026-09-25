import { SAFE_MOISTURE } from './planner.js';

const STAGE_NAME = {
  harvest: '收割',
  transport: '单轨转运',
  dry: '烘干',
};

function bookingsOfBatch(state, batchId) {
  return [...state.bookings.values()]
    .filter((b) => b.batchId === batchId)
    .sort((a, b) => chainOrder(a) - chainOrder(b) || (a.trip ?? 0) - (b.trip ?? 0));
}
function chainOrder(b) {
  return { harvest: 0, transport: 1, dry: 2 }[b.stage] ?? 3;
}

// 每批稻谷当前在哪、下一台设备是谁。
export function traceBatch(state, batchId) {
  const batch = state.batches.get(batchId);
  if (!batch) throw new Error(`批次不存在：${batchId}`);
  const plot = state.plots.get(batch.plotId);
  const bookings = bookingsOfBatch(state, batchId);

  let next = null;
  for (const b of bookings) {
    if (b.status === 'queued' || b.status === 'blocked' || b.status === 'booked') {
      const eq = state.equipment.get(b.resourceId);
      next = {
        stage: b.stage,
        stageName: STAGE_NAME[b.stage],
        equipmentId: b.resourceId,
        equipmentName: eq?.name ?? b.resourceId,
        status: b.status,
        reason: b.blockedReason ?? null,
        plannedStart: b.start ?? null,
        plannedEnd: b.end ?? null,
      };
      break;
    }
    if (b.status === 'running') {
      const eq = state.equipment.get(b.resourceId);
      next = {
        stage: b.stage,
        stageName: STAGE_NAME[b.stage] + '（进行中）',
        equipmentId: b.resourceId,
        equipmentName: eq?.name ?? b.resourceId,
        status: 'running',
        plannedEnd: b.end ?? null,
      };
      break;
    }
  }

  // 交接链去向：每个未完成环节都指向下一环节的资源。
  const chain = bookings.map((b) => {
    const eq = state.equipment.get(b.resourceId);
    return {
      stage: b.stage,
      trip: b.trip ?? null,
      equipmentId: b.resourceId,
      equipmentName: eq?.name ?? b.resourceId,
      status: b.status,
    };
  });

  return {
    batchId,
    plotId: batch.plotId,
    coop: batch.coop,
    weightKg: batch.weightKg,
    location: batch.location,
    destination: batch.destination,
    destinationName: state.equipment.get(batch.destination)?.name ?? batch.destination,
    next,
    chain,
    moistureIntake: batch.moistureIntake?.value ?? null,
    moistureFinal: batch.moistureFinal?.value ?? null,
    stored: batch.stored,
    safe: batch.safe,
    deadline: plot.deadline,
  };
}

// 延期影响了哪些地块：原因、发生时间、当前计划完成时间是否仍晚于最晚完成时间。
export function delayImpact(state) {
  const byPlot = new Map();
  for (const d of state.delays) {
    if (!byPlot.has(d.plotId)) byPlot.set(d.plotId, []);
    byPlot.get(d.plotId).push(d);
  }
  const out = [];
  for (const [plotId, delays] of byPlot) {
    const plot = state.plots.get(plotId);
    let plannedFinish = null;
    for (const b of state.bookings.values()) {
      if (b.plotId !== plotId) continue;
      if (['queued', 'blocked', 'booked', 'running', 'interrupted'].includes(b.status)) {
        const finishAt = b.end ?? null;
        if (finishAt !== null) plannedFinish = Math.max(plannedFinish ?? 0, finishAt);
        else plannedFinish = null; // 还有未排定环节，完成时间未知
      }
    }
    out.push({
      plotId,
      coop: plot.coop,
      deadline: plot.deadline,
      reasons: [...new Set(delays.map((d) => d.reason))],
      delayCount: delays.length,
      lastDelayAt: delays.at(-1).at,
      plannedFinish,
      stillLate: plannedFinish === null ? null : plannedFinish > plot.deadline,
    });
  }
  return out.sort((a, b) => (b.stillLate ? 1 : 0) - (a.stillLate ? 1 : 0) || a.deadline - b.deadline);
}

// 最终是否达到安全储存标准。
export function storageReport(state) {
  return [...state.batches.values()].map((batch) => ({
    batchId: batch.id,
    plotId: batch.plotId,
    coop: batch.coop,
    stored: batch.stored,
    safe: batch.safe,
    moistureIntake: batch.moistureIntake?.value ?? null,
    moistureFinal: batch.moistureFinal?.value ?? null,
    safeThreshold: SAFE_MOISTURE,
    needRecheck: batch.needRecheck,
    verdict: !batch.stored ? '未入库' : batch.safe ? '达标入库' : '超标，禁止入库',
  }));
}

// 调度看板：每台设备的队列顺序与当前占用。
export function equipmentBoard(state) {
  return [...state.equipment.values()].map((eq) => {
    const queue = (state.queues.get(eq.id) ?? [])
      .map((id) => state.bookings.get(id))
      .filter(Boolean)
      .map((b) => ({
        bookingId: b.id,
        plotId: b.plotId,
        batchId: b.batchId,
        stage: b.stage,
        status: b.status,
        reason: b.blockedReason ?? null,
      }));
    const running = [...state.bookings.values()]
      .filter((b) => b.resourceId === eq.id && (b.status === 'running' || b.status === 'booked'))
      .map((b) => ({ bookingId: b.id, status: b.status, start: b.start, end: b.end }));
    return {
      equipmentId: eq.id,
      name: eq.name,
      kind: eq.kind,
      village: eq.village,
      down: eq.down,
      busy: running,
      queue,
    };
  });
}
