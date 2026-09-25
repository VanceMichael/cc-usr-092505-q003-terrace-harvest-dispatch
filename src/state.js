// 领域状态：只能通过事件演进。进程重启后用 replay(events) 完整重建。

export function createState() {
  return {
    seq: 0,
    plots: new Map(),
    equipment: new Map(),
    bookings: new Map(),
    batches: new Map(),
    // 每个资源一条 FIFO 等待队列，存排队序号而非时间，重启后顺序不变。
    queues: new Map(),
    rain: [],
    delays: [], // {plotId, reason, at}
    txIds: new Set(),
  };
}

export function replay(events) {
  const state = createState();
  for (const event of events) applyEvent(state, event);
  return state;
}

export function applyEvent(state, event) {
  switch (event.type) {
    case 'PlotRegistered': {
      state.plots.set(event.plotId, {
        id: event.plotId,
        coop: event.coop,
        maturity: event.maturity,
        slope: event.slope,
        yieldKg: event.yieldKg,
        deadline: event.deadline,
        accessible: event.accessible,
        confirmed: false,
        status: 'registered',
        batchIds: [],
      });
      break;
    }
    case 'PlotConfirmed': {
      const plot = state.plots.get(event.plotId);
      plot.confirmed = true;
      plot.status = 'confirmed';
      break;
    }
    case 'EquipmentRegistered': {
      state.equipment.set(event.equipmentId, {
        id: event.equipmentId,
        kind: event.kind, // harvester | monorail | dryer
        name: event.name,
        village: event.village,
        maxSlope: event.maxSlope ?? null,
        capacityKg: event.capacityKg ?? null,
        shifts: event.shifts ?? null, // 收割机班次 [{start,end}]（每日循环，毫秒偏移）
        down: false,
        downtime: [],
        transfers: [],
      });
      state.queues.set(event.equipmentId, []);
      break;
    }
    case 'DowntimeReported': {
      const eq = state.equipment.get(event.equipmentId);
      eq.downtime.push({ start: event.start, end: event.end ?? null, reason: event.reason });
      if (event.end === null || event.end > event.at) eq.down = true;
      break;
    }
    case 'DowntimeResolved': {
      const eq = state.equipment.get(event.equipmentId);
      const open = [...eq.downtime].reverse().find((d) => d.end === null);
      if (open) open.end = event.at;
      eq.down = false;
      break;
    }
    case 'EquipmentTransferred': {
      const eq = state.equipment.get(event.equipmentId);
      eq.transfers.push({ start: event.start, end: event.end, fromVillage: eq.village, toVillage: event.toVillage });
      eq.village = event.toVillage;
      break;
    }
    case 'RainfallRecorded': {
      state.rain.push({ start: event.start, end: event.end, stages: event.stages });
      break;
    }
    case 'RainfallCleared': {
      for (const r of state.rain) {
        if (r.end === null && r.stages.some((s) => event.stages.includes(s))) r.end = event.at;
      }
      break;
    }
    case 'BookingEnqueued': {
      const b = event.booking;
      state.bookings.set(b.id, { ...b, status: 'queued' });
      state.queues.get(b.resourceId).push(b.id);
      break;
    }
    case 'BookingBooked': {
      const b = state.bookings.get(event.bookingId);
      const q = state.queues.get(b.resourceId);
      const pos = q.indexOf(b.id);
      if (pos >= 0) q.splice(pos, 1);
      b.status = 'booked';
      if (event.start !== undefined) b.start = event.start;
      if (event.end !== undefined) b.end = event.end;
      break;
    }
    case 'BookingRescheduled': {
      const b = state.bookings.get(event.bookingId);
      // 已排定的预约被打回队列，保留队首位置：先重试它，仍冲突才让后面的越过。
      if (['booked', 'running', 'interrupted', 'blocked'].includes(b.status)) {
        const q = state.queues.get(b.resourceId);
        if (q && !q.includes(b.id)) q.unshift(b.id);
      }
      b.status = 'queued';
      b.start = event.start;
      b.end = event.end;
      b.reason = event.reason;
      if (event.remainingMs !== undefined) b.remainingMs = event.remainingMs;
      if (event.durationMs !== undefined) b.durationMs = event.durationMs;
      break;
    }
    case 'BookingDependencyMoved': {
      const b = state.bookings.get(event.bookingId);
      b.dependsOn = event.toBookingId;
      break;
    }
    case 'TripWeightAdjusted': {
      state.bookings.get(event.bookingId).tripKg = event.tripKg;
      break;
    }
    case 'BookingReassigned': {
      const b = state.bookings.get(event.bookingId);
      const old = state.queues.get(event.fromResource);
      if (old) {
        const pos = old.indexOf(b.id);
        if (pos >= 0) old.splice(pos, 1);
      }
      b.resourceId = event.toResource;
      b.status = 'queued';
      // 改派作为新请求进入目标队列队尾，旧时段立即释放。
      b.start = null;
      b.end = null;
      delete b.blockedReason;
      delete b.remainingMs;
      state.queues.get(event.toResource).push(b.id);
      break;
    }
    case 'BookingStarted': {
      const b = state.bookings.get(event.bookingId);
      b.status = 'running';
      b.startedAt = event.at;
      b.runSince = event.at;
      break;
    }
    case 'BookingBlocked': {
      const b = state.bookings.get(event.bookingId);
      b.status = 'blocked';
      b.blockedReason = event.reason;
      b.blockedAt = event.at;
      break;
    }
    case 'BookingUnblocked': {
      const b = state.bookings.get(event.bookingId);
      if (b.status === 'blocked') {
        b.status = 'queued';
        delete b.blockedReason;
      }
      break;
    }
    case 'BookingInterrupted': {
      const b = state.bookings.get(event.bookingId);
      b.status = 'interrupted';
      b.interruptedAt = event.at;
      b.interruptReason = event.reason;
      if (event.workedMs !== undefined) b.workedMs = event.workedMs;
      if (event.remainingMs !== undefined) b.remainingMs = event.remainingMs;
      delete b.runSince;
      break;
    }
    case 'BookingResumed': {
      const b = state.bookings.get(event.bookingId);
      b.status = 'running';
      b.runSince = event.at;
      break;
    }
    case 'BookingCompleted': {
      const b = state.bookings.get(event.bookingId);
      b.status = 'done';
      b.completedAt = event.at;
      break;
    }
    case 'BookingCancelled': {
      const b = state.bookings.get(event.bookingId);
      const q = state.queues.get(b.resourceId);
      const pos = q.indexOf(b.id);
      if (pos >= 0) q.splice(pos, 1);
      b.status = 'cancelled';
      b.cancelReason = event.reason;
      break;
    }
    case 'BatchCreated': {
      const plot = state.plots.get(event.plotId);
      const batch = {
        id: event.batchId,
        plotId: event.plotId,
        coop: plot.coop,
        weightKg: null,
        location: 'planned',
        destination: event.destination ?? null,
        chain: [{ stage: 'harvest', bookingId: event.harvestBookingId }],
        moistureIntake: null,
        moistureFinal: null,
        needRecheck: false,
        stored: false,
        safe: null,
      };
      state.batches.set(event.batchId, batch);
      plot.batchIds.push(event.batchId);
      break;
    }
    case 'BatchChainAppended': {
      const batch = state.batches.get(event.batchId);
      batch.chain.push({ stage: event.stage, bookingId: event.bookingId });
      break;
    }
    case 'BatchRecheckRequired': {
      state.batches.get(event.batchId).needRecheck = true;
      break;
    }
    case 'BatchRecheckCleared': {
      state.batches.get(event.batchId).needRecheck = false;
      break;
    }
    case 'BatchWeighed': {
      state.batches.get(event.batchId).weightKg = event.kg;
      break;
    }
    case 'BatchMoved': {
      const batch = state.batches.get(event.batchId);
      batch.location = event.to;
      batch.destination = event.destination ?? batch.destination;
      break;
    }
    case 'MoistureRecorded': {
      const batch = state.batches.get(event.batchId);
      if (event.stage === 'intake') batch.moistureIntake = { value: event.value, at: event.at, by: event.by };
      if (event.stage === 'final') batch.moistureFinal = { value: event.value, at: event.at, by: event.by };
      break;
    }
    case 'BatchStored': {
      const batch = state.batches.get(event.batchId);
      batch.stored = true;
      batch.safe = event.safe;
      batch.location = 'warehouse';
      batch.storedAt = event.at;
      break;
    }
    case 'PlotDelayed': {
      const plot = state.plots.get(event.plotId);
      plot.status = 'delayed';
      state.delays.push({ plotId: event.plotId, reason: event.reason, at: event.at });
      break;
    }
    default:
      throw new Error(`未知事件类型：${event.type}`);
  }
  state.seq += 1;
  return state;
}
