import { propose, harvestDurationMs, transportDurationMs, dryDurationMs, SAFE_MOISTURE } from './planner.js';

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export const ROLES = {
  dispatcher: '农机中心调度员',
  coop: '种植合作社',
  operator: '设备操作人员',
  quality: '粮食品质人员',
};

const STAGES = ['harvester', 'monorail', 'dryer'];

export class HarvestService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
  }

  get state() {
    return this.store.state;
  }

  get now() {
    return this.clock.now();
  }

  commit(txId, events) {
    if (!events.length) throw new Error('空事务不允许提交');
    return this.store.commit(txId, this.now, events);
  }

  require(ctx, roles) {
    if (!roles.includes(ctx.role)) {
      throw new Error(`${ctx.role ?? '未知角色'}无权执行该操作（需要 ${roles.join('/')}）`);
    }
  }

  ownPlot(ctx, plotId) {
    const plot = this.state.plots.get(plotId);
    if (!plot) throw new Error(`地块不存在：${plotId}`);
    if (ctx.role === ROLES.coop && ctx.coop !== plot.coop) {
      throw new Error('合作社只能操作自己的地块与批次');
    }
    return plot;
  }

  ownBatch(ctx, batchId) {
    const batch = this.state.batches.get(batchId);
    if (!batch) throw new Error(`批次不存在：${batchId}`);
    if (ctx.role === ROLES.coop && ctx.coop !== batch.coop) {
      throw new Error('合作社只能确认自己的批次');
    }
    return batch;
  }

  // ---------- 登记 ----------

  registerPlot(txId, ctx, input) {
    this.require(ctx, [ROLES.coop, ROLES.dispatcher]);
    const plotId = input.id ?? newId('plot');
    if (this.state.plots.has(plotId)) throw new Error(`地块已登记：${plotId}`);
    const coop = input.coop ?? ctx.coop;
    if (ctx.role === ROLES.coop && input.coop && input.coop !== ctx.coop) {
      throw new Error('不能替其他合作社登记地块');
    }
    if (!coop) throw new Error('缺少合作社归属');
    if (![0, 1, 2, 3].includes(input.maturity)) throw new Error('成熟度需为 0-3');
    if (!(input.slope >= 0) || !(input.yieldKg > 0) || !(input.deadline > this.now)) {
      throw new Error('坡度、预计产量、最晚完成时间不合法');
    }
    if (!Array.isArray(input.accessible) || input.accessible.length === 0) {
      throw new Error('至少登记一台可达收割设备');
    }
    this.commit(txId, [
      {
        type: 'PlotRegistered',
        at: this.now,
        plotId,
        coop,
        maturity: input.maturity,
        slope: input.slope,
        yieldKg: input.yieldKg,
        deadline: input.deadline,
        accessible: [...input.accessible],
      },
    ]);
    return plotId;
  }

  // 合作社只能确认自己的地块。
  confirmPlot(txId, ctx, plotId) {
    this.require(ctx, [ROLES.coop]);
    const plot = this.ownPlot(ctx, plotId);
    if (plot.confirmed) throw new Error('地块已确认');
    this.commit(txId, [{ type: 'PlotConfirmed', at: this.now, plotId }]);
  }

  registerEquipment(txId, ctx, input) {
    this.require(ctx, [ROLES.dispatcher]);
    const id = input.id ?? newId(input.kind);
    if (this.state.equipment.has(id)) throw new Error(`设备已登记：${id}`);
    if (!STAGES.includes(input.kind)) throw new Error('设备类型不合法');
    this.commit(txId, [
      {
        type: 'EquipmentRegistered',
        at: this.now,
        equipmentId: id,
        kind: input.kind,
        name: input.name ?? id,
        village: input.village ?? '本村',
        maxSlope: input.maxSlope ?? null,
        capacityKg: input.capacityKg ?? null,
        shifts: input.shifts ?? null,
      },
    ]);
    return id;
  }

  // ---------- 交接链：收割 → 单轨转运（分趟）→ 连续烘干 ----------

  // 整条链在同一事务内建立：批次自建立起就有明确去向（烘干仓）。
  requestChain(txId, ctx, input) {
    this.require(ctx, [ROLES.coop, ROLES.dispatcher]);
    const plot = this.ownPlot(ctx, input.plotId);
    if (!plot.confirmed) throw new Error('地块未经合作社确认，不能排产');
    const harvester = this.state.equipment.get(input.harvesterId);
    const monorail = this.state.equipment.get(input.monorailId);
    const dryer = this.state.equipment.get(input.dryerId);
    if (!harvester || harvester.kind !== 'harvester') throw new Error('收割机不存在');
    if (!monorail || monorail.kind !== 'monorail') throw new Error('单轨区段不存在');
    if (!dryer || dryer.kind !== 'dryer') throw new Error('烘干仓不存在');
    // 可达性、坡度、载重等属性约束不在入队时拒绝：交由调度按 FIFO 裁决，
    // 自身条件不满足的预约标记 blocked 留队，后续预约可越过。
    if (dryer.capacityKg !== null && plot.yieldKg > dryer.capacityKg) {
      throw new Error(`预计产量超过烘干仓容量 ${dryer.capacityKg}kg`);
    }

    const batchId = newId('batch');
    const hId = newId('bk');
    const events = [
      {
        type: 'BatchCreated',
        at: this.now,
        batchId,
        plotId: plot.id,
        harvestBookingId: hId,
        destination: dryer.id,
      },
      {
        type: 'BookingEnqueued',
        at: this.now,
        booking: {
          id: hId,
          resourceId: harvester.id,
          stage: 'harvest',
          plotId: plot.id,
          batchId,
          durationMs: harvestDurationMs(plot.yieldKg),
          dependsOn: null,
          requester: ctx.coop ?? 'dispatcher',
        },
      },
    ];

    const trips = this._planTrips(events, {
      plot,
      batchId,
      monorailId: monorail.id,
      kg: plot.yieldKg,
      capacityKg: monorail.capacityKg ?? plot.yieldKg,
      firstDependsOn: hId,
    });

    const dId = newId('bk');
    events.push({
      type: 'BookingEnqueued',
      at: this.now,
      booking: {
        id: dId,
        resourceId: dryer.id,
        stage: 'dry',
        plotId: plot.id,
        batchId,
        durationMs: dryDurationMs(null),
        dependsOn: trips[trips.length - 1],
        requester: ctx.coop ?? 'dispatcher',
      },
    });

    this.commit(txId, events);
    this.schedule();
    return { batchId, harvestBookingId: hId, transportBookingIds: trips, dryBookingId: dId };
  }

  _planTrips(events, { plot, batchId, monorailId, kg, capacityKg, firstDependsOn }) {
    const count = Math.max(1, Math.ceil(kg / capacityKg));
    const ids = [];
    let dependsOn = firstDependsOn;
    let loaded = 0;
    for (let i = 0; i < count; i += 1) {
      const tripKg = Math.min(capacityKg, kg - loaded); // 先装满载，末趟装余量
      loaded += tripKg;
      const id = newId('bk');
      events.push({
        type: 'BookingEnqueued',
        at: this.now,
        booking: {
          id,
          resourceId: monorailId,
          stage: 'transport',
          plotId: plot.id,
          batchId,
          durationMs: transportDurationMs(),
          dependsOn,
          trip: i + 1,
          tripKg,
          requester: 'dispatcher',
        },
      });
      ids.push(id);
      dependsOn = id;
    }
    return ids;
  }

  // 实际称重：修正趟次数与载重。只能增删/改重尚未开始的趟次。
  weighBatch(txId, ctx, batchId, kg) {
    this.require(ctx, [ROLES.operator, ROLES.dispatcher]);
    const batch = this.ownBatch(ctx, batchId);
    if (!(kg > 0)) throw new Error('称重不合法');
    const events = [{ type: 'BatchWeighed', at: this.now, batchId, kg }];

    const trips = [...this.state.bookings.values()]
      .filter((b) => b.batchId === batchId && b.stage === 'transport' && b.status !== 'cancelled')
      .sort((a, b) => a.trip - b.trip);
    if (!trips.length) throw new Error('该批次没有转运趟次');
    const monorail = this.state.equipment.get(trips[0].resourceId);
    const capacityKg = monorail.capacityKg ?? kg;
    // 尚未装载的趟次均可调整：排队中、被阻断、或已排定但还没到开始时间。
    const pending = trips.filter((b) => b.status === 'queued' || b.status === 'blocked' || (b.status === 'booked' && b.start > this.now));
    const started = trips.filter((b) => !pending.includes(b));
    const fixedKg = started.reduce((sum, b) => sum + (b.tripKg ?? 0), 0);
    const remainingKg = Math.max(0, kg - fixedKg);
    const need = Math.max(pending.length ? 1 : 0, Math.ceil(remainingKg / capacityKg));
    const targetCount = started.length + need;

    if (targetCount > trips.length) {
      // 增趟：接在链尾，烘干依赖顺延到新尾趟。
      const plot = this.state.plots.get(batch.plotId);
      let dependsOn = trips[trips.length - 1].id;
      for (let i = trips.length; i < targetCount; i += 1) {
        const id = newId('bk');
        events.push({
          type: 'BookingEnqueued',
          at: this.now,
          booking: {
            id,
            resourceId: monorail.id,
            stage: 'transport',
            plotId: plot.id,
            batchId,
            durationMs: transportDurationMs(),
            dependsOn,
            trip: i + 1,
            tripKg: 0,
            requester: 'dispatcher',
          },
        });
        dependsOn = id;
      }
    } else if (targetCount < trips.length) {
      // 减趟：只取消队尾多余的未开始趟次；已装载趟次一律保留走完。
      const excess = pending.slice(pending.length - (trips.length - targetCount));
      for (const b of excess) {
        events.push({ type: 'BookingCancelled', at: this.now, bookingId: b.id, reason: '实际称重后核减趟次' });
      }
    }

    this._relinkAndRebalance(events, batchId, kg, capacityKg);
    this.commit(txId, events);
    this.schedule();
  }

  _relinkAndRebalance(events, batchId, kg, capacityKg) {
    // 合并本事务中尚未提交的新增/取消/调整，得到趟次的“事务后视图”。
    const harvest = [...this.state.bookings.values()].find(
      (b) => b.batchId === batchId && b.stage === 'harvest'
    );
    const cancelled = new Set(events.filter((e) => e.type === 'BookingCancelled').map((e) => e.bookingId));
    const added = events
      .filter((e) => e.type === 'BookingEnqueued')
      .map((e) => e.booking);
    const weightAt = new Map(events.filter((e) => e.type === 'TripWeightAdjusted').map((e) => [e.bookingId, e.tripKg]));
    const depAt = new Map(events.filter((e) => e.type === 'BookingDependencyMoved').map((e) => [e.bookingId, e.toBookingId]));

    const statusOf = (b) => b.status ?? 'queued'; // 本事务新入队的预约尚无 status 字段
    const trips = [
      ...[...this.state.bookings.values()].filter((b) => b.batchId === batchId && b.stage === 'transport' && !cancelled.has(b.id) && b.status !== 'cancelled'),
      ...added,
    ].sort((a, b) => a.trip - b.trip);

    let prev = harvest?.id ?? null;
    for (const t of trips) {
      const expectedDep = depAt.get(t.id) ?? t.dependsOn;
      if (expectedDep !== prev && ['queued', 'blocked', 'booked'].includes(statusOf(t))) {
        if (!depAt.has(t.id)) {
          events.push({ type: 'BookingDependencyMoved', at: this.now, bookingId: t.id, fromBookingId: t.dependsOn, toBookingId: prev });
          depAt.set(t.id, prev);
        }
      }
      prev = t.id;
    }
    const dry = [...this.state.bookings.values()].find((b) => b.batchId === batchId && b.stage === 'dry');
    const tail = trips[trips.length - 1];
    if (dry && tail) {
      const expectedDep = depAt.get(dry.id) ?? dry.dependsOn;
      if (expectedDep !== tail.id && ['queued', 'blocked', 'booked'].includes(dry.status)) {
        if (!events.some((e) => e.type === 'BookingDependencyMoved' && e.bookingId === dry.id)) {
          events.push({ type: 'BookingDependencyMoved', at: this.now, bookingId: dry.id, fromBookingId: dry.dependsOn, toBookingId: tail.id });
        }
      }
    }

    const pending = trips.filter((b) => statusOf(b) === 'queued' || statusOf(b) === 'blocked' || (statusOf(b) === 'booked' && b.start > this.now));
    if (!pending.length) return;
    const fixedKg = trips.reduce((sum, b) => sum + (pending.includes(b) ? 0 : (weightAt.get(b.id) ?? b.tripKg ?? 0)), 0);
    let remaining = Math.max(0, kg - fixedKg);
    for (const b of pending) {
      const tripKg = Math.min(capacityKg, remaining);
      remaining -= tripKg;
      if (weightAt.has(b.id)) {
        const e = events.find((x) => x.type === 'TripWeightAdjusted' && x.bookingId === b.id);
        e.tripKg = tripKg;
      } else {
        events.push({ type: 'TripWeightAdjusted', at: this.now, bookingId: b.id, tripKg });
      }
    }
  }

  // ---------- 故障 / 降雨 / 跨村调机（按发生顺序追加） ----------

  reportDowntime(txId, ctx, equipmentId, reason, end = null) {
    this.require(ctx, [ROLES.dispatcher, ROLES.operator]);
    const eq = this.state.equipment.get(equipmentId);
    if (!eq) throw new Error('设备不存在');
    if (eq.down) throw new Error('设备已在停机隔离中');
    const events = [{ type: 'DowntimeReported', at: this.now, start: this.now, end, equipmentId, reason }];
    this._interruptOverlaps(events, eq, '设备故障：' + reason, null, end ?? Infinity);
    this.commit(txId, events);
    this.schedule();
  }

  resolveDowntime(txId, ctx, equipmentId) {
    this.require(ctx, [ROLES.dispatcher, ROLES.operator]);
    const eq = this.state.equipment.get(equipmentId);
    if (!eq || !eq.down) throw new Error('设备未处于停机状态');
    this.commit(txId, [{ type: 'DowntimeResolved', at: this.now, equipmentId }]);
    this.schedule();
  }

  recordRain(txId, ctx, end = null, stages = ['harvest', 'transport']) {
    this.require(ctx, [ROLES.dispatcher, ROLES.operator]);
    const events = [{ type: 'RainfallRecorded', at: this.now, start: this.now, end, stages }];
    // 降雨停工打断田间与单轨作业；仓内连续烘干不中断。
    for (const eq of this.state.equipment.values()) {
      if (eq.kind === 'dryer') continue;
      this._interruptOverlaps(events, eq, '降雨停工', stages);
    }
    this.commit(txId, events);
    this.schedule();
  }

  clearRain(txId, ctx) {
    this.require(ctx, [ROLES.dispatcher, ROLES.operator]);
    this.commit(txId, [{ type: 'RainfallCleared', at: this.now, stages: ['harvest', 'transport'] }]);
    this.schedule();
  }

  // 跨村调机：离村运输期间设备不可用，只影响尚未开始/进行中的作业。
  transferEquipment(txId, ctx, equipmentId, toVillage, durationMs) {
    this.require(ctx, [ROLES.dispatcher]);
    const eq = this.state.equipment.get(equipmentId);
    if (!eq) throw new Error('设备不存在');
    if (eq.down) throw new Error('故障设备不能跨村调机');
    const events = [
      {
        type: 'EquipmentTransferred',
        at: this.now,
        start: this.now,
        end: this.now + durationMs,
        equipmentId,
        toVillage,
      },
    ];
    this._interruptOverlaps(events, eq, `跨村调机至${toVillage}`, null, this.now + durationMs);
    this.commit(txId, events);
    this.schedule();
  }

  _interruptOverlaps(events, eq, reason, onlyStages = null, blockedEnd = Infinity) {
    const hit = [];
    for (const b of [...this.state.bookings.values()].sort((x, y) => (x.start ?? 0) - (y.start ?? 0))) {
      if (b.resourceId !== eq.id) continue;
      if (onlyStages && !onlyStages.includes(b.stage)) continue;
      if (b.status === 'running') {
        const workedMs = this.now - (b.runSince ?? b.start);
        const totalWorked = (b.workedMs ?? 0) + workedMs;
        const remainingMs = Math.max(0, b.durationMs - totalWorked);
        events.push({
          type: 'BookingInterrupted',
          at: this.now,
          bookingId: b.id,
          reason,
          workedMs: totalWorked,
          remainingMs: b.stage === 'dry' ? b.durationMs : remainingMs,
        });
        if (b.stage === 'dry') {
          // 烘干必须连续：中断即整批作废重做，须品质复测后才能重开。
          events.push({ type: 'BatchRecheckRequired', at: this.now, batchId: b.batchId, reason });
        }
        hit.push({ b, remainingMs: b.stage === 'dry' ? b.durationMs : remainingMs });
        this._markDelayed(events, b.plotId, reason);
      } else if (b.status === 'booked' && b.start < blockedEnd && b.end > this.now) {
        hit.push({ b, remainingMs: undefined });
        this._markDelayed(events, b.plotId, reason);
      }
    }
    // 重排事件按开始时间倒序落日志：reducer 逐个前移到队首，最终队列仍保持原来的先后顺序。
    for (const { b, remainingMs } of hit.reverse()) {
      events.push({
        type: 'BookingRescheduled',
        at: this.now,
        bookingId: b.id,
        start: null,
        end: null,
        reason,
        ...(remainingMs !== undefined ? { remainingMs } : {}),
      });
    }
  }

  _markDelayed(events, plotId, reason) {
    const plot = this.state.plots.get(plotId);
    if (!plot) return;
    const last = this.state.delays.filter((d) => d.plotId === plotId).at(-1);
    const pending = events.filter((e) => e.type === 'PlotDelayed' && e.plotId === plotId).at(-1);
    const lastReason = pending?.reason ?? last?.reason;
    if (lastReason !== reason) events.push({ type: 'PlotDelayed', at: this.now, plotId, reason });
  }

  // ---------- 改派：只能释放尚未开始的资源 ----------

  reassignBooking(txId, ctx, bookingId, toResourceId) {
    this.require(ctx, [ROLES.dispatcher]);
    const b = this.state.bookings.get(bookingId);
    if (!b) throw new Error('预约不存在');
    const target = this.state.equipment.get(toResourceId);
    if (!target) throw new Error('目标设备不存在');
    const source = this.state.equipment.get(b.resourceId);
    if (source.kind !== target.kind) throw new Error('只能改派到同类设备');
    if (!['queued', 'blocked'].includes(b.status) && !(b.status === 'booked' && b.start > this.now)) {
      throw new Error('作业已经开始或粮食已装载，不能改派；必须沿原交接链到达明确去向');
    }
    if (b.stage === 'harvest') {
      const plot = this.state.plots.get(b.plotId);
      if (!plot.accessible.includes(toResourceId)) throw new Error('目标收割机不可达该地块');
      if (target.maxSlope !== null && plot.slope > target.maxSlope) throw new Error('目标收割机坡度不满足');
    }
    if ((b.stage === 'transport' || b.stage === 'dry') && target.capacityKg !== null) {
      const kg = b.tripKg ?? this.state.batches.get(b.batchId)?.weightKg ?? this.state.plots.get(b.plotId).yieldKg;
      if (kg > target.capacityKg) throw new Error(`粮食 ${kg}kg 超过目标容量 ${target.capacityKg}kg`);
    }
    // 释放旧资源与占用新资源在同一事务：失败不留半份预约。
    this.commit(txId, [
      { type: 'BookingReassigned', at: this.now, bookingId, fromResource: b.resourceId, toResource: toResourceId },
    ]);
    this.schedule();
  }

  // ---------- 品质：独立记录水分 ----------

  recordMoisture(txId, ctx, batchId, stage, value) {
    this.require(ctx, [ROLES.quality]);
    const batch = this.ownBatch(ctx, batchId);
    if (!['intake', 'final'].includes(stage)) throw new Error('水分阶段只能是 intake/final');
    if (!(value > 0 && value < 40)) throw new Error('水分值不合法');
    const events = [{ type: 'MoistureRecorded', at: this.now, batchId, stage, value, by: ctx.who ?? ctx.role }];
    if (stage === 'intake') {
      if (batch.needRecheck) events.push({ type: 'BatchRecheckCleared', at: this.now, batchId });
      const b = [...this.state.bookings.values()].find((x) => x.batchId === batchId && x.stage === 'dry');
      const notStarted = b && ['queued', 'blocked'].includes(b.status) || (b?.status === 'booked' && b.start > this.now);
      if (notStarted) {
        // 实测水分改变连续烘干时长：重排，冲突由调度裁决。
        events.push({
          type: 'BookingRescheduled',
          at: this.now,
          bookingId: b.id,
          start: null,
          end: null,
          reason: '按实测入库水分重算连续烘干时长',
          durationMs: dryDurationMs(value),
        });
      }
    }
    this.commit(txId, events);
    this.schedule();
  }

  storeBatch(txId, ctx, batchId, finalMoisture) {
    this.require(ctx, [ROLES.quality]);
    const batch = this.ownBatch(ctx, batchId);
    const dry = [...this.state.bookings.values()].find((b) => b.batchId === batchId && b.stage === 'dry');
    if (!dry || dry.status !== 'done') throw new Error('烘干未完成，不能入库');
    const value = finalMoisture ?? batch.moistureFinal?.value;
    if (value === undefined) throw new Error('缺少入库水分复测值');
    const safe = value <= SAFE_MOISTURE;
    const events = [
      { type: 'MoistureRecorded', at: this.now, batchId, stage: 'final', value, by: ctx.who ?? ctx.role },
    ];
    if (safe) events.push({ type: 'BatchStored', at: this.now, batchId, safe: true });
    // 超标：不产生入库事件，批次留在烘干待处理区，等待返烘后再次复测。
    this.commit(txId, events);
    return safe;
  }

  // 复测超标：调度员安排返烘，产生新的连续烘干预约，完成后由质检再次复测。
  requestRedry(txId, ctx, batchId) {
    this.require(ctx, [ROLES.dispatcher]);
    const batch = this.ownBatch(ctx, batchId);
    if (batch.stored) throw new Error('批次已入库');
    const lastDry = [...this.state.bookings.values()]
      .filter((b) => b.batchId === batchId && b.stage === 'dry')
      .at(-1);
    if (lastDry && !['done'].includes(lastDry.status)) throw new Error('上一轮烘干尚未结束');
    const id = newId('bk');
    const m = batch.moistureFinal?.value ?? batch.moistureIntake?.value ?? null;
    this.commit(txId, [
      {
        type: 'BookingEnqueued',
        at: this.now,
        booking: {
          id,
          resourceId: batch.destination,
          stage: 'dry',
          plotId: batch.plotId,
          batchId,
          durationMs: dryDurationMs(m),
          dependsOn: null,
          retry: true,
          requester: 'dispatcher',
        },
      },
      { type: 'BatchChainAppended', at: this.now, batchId, stage: 'dry', bookingId: id },
    ]);
    this.schedule();
    return id;
  }

  // ---------- 调度裁决 ----------

  // 逐资源 FIFO：队首先取最早可行时段并立即落为占用；后续预约搜索时绕开它。
  // 自身条件不满足（超重/不可达/等复测/等依赖）的预约标记 blocked 留队，后续可越过。
  schedule() {
    let produced = 0;
    for (const resourceId of [...this.state.queues.keys()]) {
      produced += this._scheduleResource(resourceId);
    }
    return produced;
  }

  _scheduleResource(resourceId) {
    const eq = this.state.equipment.get(resourceId);
    const q = this.state.queues.get(resourceId);
    if (!eq || !q) return 0;
    let produced = 0;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const bookingId of [...q]) {
        const b = this.state.bookings.get(bookingId);
        if (!b || ['done', 'cancelled', 'running', 'interrupted'].includes(b?.status)) {
          const pos = q.indexOf(bookingId);
          if (pos >= 0) q.splice(pos, 1);
          continue;
        }
        if (!['queued', 'blocked'].includes(b.status)) continue;
        // 设备停机/调机/降雨的不可用区间已在规划器的 blockedIntervals 中，
        // 这里不整体跳过：自身阻断（如等待品质复测）仍需落标记。

        const result = propose(this.state, b, this.now);
        const events = [];
        if (result.start !== undefined) {
          if (b.status === 'blocked') events.push({ type: 'BookingUnblocked', at: this.now, bookingId: b.id });
          const duration = b.remainingMs ?? b.durationMs;
          events.push({ type: 'BookingBooked', at: this.now, bookingId: b.id, start: result.start, end: result.start + duration });
          if (result.late) this._markDelayed(events, b.plotId, result.reason);
        } else if (result.blocker === 'self') {
          if (b.status !== 'blocked') events.push({ type: 'BookingBlocked', at: this.now, bookingId: b.id, reason: result.reason });
        }
        if (events.length) {
          this.store.commit(newId('tx'), this.now, events);
          produced += 1;
          progressed = true;
        }
      }
    }
    return produced;
  }

  // ---------- 时间推进：到期开工、完工交接；重启后续跑 ----------

  wake() {
    let loops = 0;
    for (;;) {
      loops += 1;
      if (loops > 10_000) throw new Error('wake 推进未收敛');
      const moved = this._wakeOnce();
      const scheduled = this.schedule();
      if (!moved && !scheduled) break;
    }
  }

  _wakeOnce() {
    const events = [];
    for (const b of [...this.state.bookings.values()].sort((x, y) => (x.start ?? Infinity) - (y.start ?? Infinity))) {
      if (b.status === 'booked') {
        const depOk = !b.dependsOn || this.state.bookings.get(b.dependsOn)?.status === 'done';
        if (b.start <= this.now && depOk && !this._resourceUnavailable(b)) {
          // 进程可能晚于计划开工时刻才观察到：工时从计划开工时刻起算。
          const startedAt = b.start;
          events.push({ type: 'BookingStarted', at: startedAt, bookingId: b.id });
          if (b.stage === 'harvest') {
            events.push({ type: 'BatchMoved', at: startedAt, batchId: b.batchId, to: 'field' });
          } else if (b.stage === 'transport') {
            // 已装载：锁定去向，必须沿交接链到达指定烘干仓。
            const batch = this.state.batches.get(b.batchId);
            events.push({ type: 'BatchMoved', at: startedAt, batchId: b.batchId, to: `monorail:${b.resourceId}`, destination: batch.destination });
          } else if (b.stage === 'dry') {
            events.push({ type: 'BatchMoved', at: startedAt, batchId: b.batchId, to: `dryer:${b.resourceId}` });
          }
        }
      } else if (b.status === 'running' && b.end <= this.now) {
        events.push({ type: 'BookingCompleted', at: this.now, bookingId: b.id });
        if (b.stage === 'harvest') {
          events.push({ type: 'BatchMoved', at: this.now, batchId: b.batchId, to: 'field' });
        } else if (b.stage === 'transport') {
          const more = [...this.state.bookings.values()].some(
            (x) => x.batchId === b.batchId && x.stage === 'transport' && ['queued', 'blocked', 'booked', 'running'].includes(x.status)
          );
          if (!more) {
            const batch = this.state.batches.get(b.batchId);
            events.push({ type: 'BatchMoved', at: this.now, batchId: b.batchId, to: `dryer-staging:${batch.destination}` });
          }
        } else if (b.stage === 'dry') {
          events.push({ type: 'BatchMoved', at: this.now, batchId: b.batchId, to: 'dryer-staged' });
        }
      }
    }
    if (events.length) this.store.commit(newId('tx'), this.now, events);
    return events.length;
  }

  _resourceUnavailable(booking) {
    const eq = this.state.equipment.get(booking.resourceId);
    if (eq.down) return true;
    for (const t of eq.transfers) if (this.now >= t.start && this.now < t.end) return true;
    for (const r of this.state.rain) {
      const active = r.end === null ? this.now >= r.start : this.now >= r.start && this.now < r.end;
      if (active && r.stages.includes(booking.stage)) return true;
    }
    return false;
  }
}

export { SAFE_MOISTURE };
