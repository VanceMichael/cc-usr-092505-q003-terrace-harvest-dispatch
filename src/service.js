// 秋收协同服务:地块登记、作业计划、资源预约、事件追加与调度查询。
// 全部状态由追加式事件日志重放得到,进程重启后到期作业、故障隔离与排队顺序保持不变。
import { EventStore } from './store.js';

export const SAFE_MOISTURE = 13.5; // 安全储存含水率上限(%)

const FAR_END = '9999-12-31T00:00:00.000Z';
const KIND_ORDER = { harvest: 0, transport: 1, dry: 2, store: 3 };
const STEP_EQUIPMENT_KIND = { harvest: 'harvester', transport: 'monorail', dry: 'dryer' };

export class PermissionError extends Error {
  get name() {
    return 'PermissionError';
  }
}
export class ConflictError extends Error {
  get name() {
    return 'ConflictError';
  }
}
export class StateError extends Error {
  get name() {
    return 'StateError';
  }
}

const at = (s) => new Date(s).getTime();
const overlaps = (a, b) =>
  at(a.start) < at(b.end ?? FAR_END) && at(b.start) < at(a.end ?? FAR_END);
const clone = (value) => JSON.parse(JSON.stringify(value));

// 预约占用的资源粒度:收割机整机、单轨区段、烘干仓。
function resourceKeyOf(r) {
  if (r.kind === 'transport') return `${r.equipmentId}/${r.sectionId}`;
  if (r.kind === 'dry') return `${r.equipmentId}/${r.binId}`;
  return r.equipmentId;
}

// 一组烘干预约在任一时刻的同时在仓量上限。
function maxConcurrentLoad(list) {
  const points = new Set();
  for (const r of list) {
    points.add(at(r.start));
    points.add(at(r.end));
  }
  let max = 0;
  for (const p of points) {
    let load = 0;
    for (const r of list) if (at(r.start) <= p && p < at(r.end)) load += r.load;
    if (load > max) max = load;
  }
  return max;
}

function needRole(actor, roles, message) {
  if (!actor || !roles.includes(actor.role)) throw new PermissionError(message);
}

export class HarvestService {
  constructor(store) {
    this.store = store;
    this.state = {
      plots: new Map(),
      equipment: new Map(),
      jobs: new Map(),
      reservations: new Map(),
      batches: new Map(),
      rainIntervals: [],
      seq: 0,
    };
  }

  // 打开(或创建)日志文件并重放全部记录。
  static async open(path) {
    const store = await EventStore.open(path);
    const service = new HarvestService(store);
    for (const rec of store.records) service._apply(rec);
    return service;
  }

  async _commit(rec) {
    rec.seq = ++this.state.seq;
    this._apply(rec);
    await this.store.append(rec);
    return rec;
  }

  _apply(rec) {
    const S = this.state;
    if (rec.seq && rec.seq > S.seq) S.seq = rec.seq;
    switch (rec.type) {
      case 'plot_registered':
        S.plots.set(rec.plot.id, { ...clone(rec.plot), confirmed: false });
        break;
      case 'plot_confirmed':
        S.plots.get(rec.plotId).confirmed = true;
        break;
      case 'equipment_registered':
        S.equipment.set(rec.equipment.id, { ...clone(rec.equipment), downIntervals: [] });
        break;
      case 'job_created':
        S.jobs.set(rec.job.id, clone(rec.job));
        rec.reservations.forEach((r, i) =>
          S.reservations.set(r.id, { ...clone(r), order: rec.seq * 1000 + i })
        );
        break;
      case 'reservations_committed':
        rec.reservations.forEach((r, i) =>
          S.reservations.set(r.id, { ...clone(r), order: rec.seq * 1000 + i })
        );
        break;
      case 'job_reassigned': {
        const job = S.jobs.get(rec.jobId);
        for (const id of rec.releasedIds) S.reservations.get(id).status = 'released';
        rec.reservations.forEach((r, i) =>
          S.reservations.set(r.id, { ...clone(r), order: rec.seq * 1000 + i })
        );
        job.steps = clone(rec.steps);
        break;
      }
      case 'step_started': {
        const job = S.jobs.get(rec.jobId);
        const step = job.steps[rec.stepIndex];
        step.status = 'active';
        job.status = 'in_progress';
        const r = this._reservationOf(rec.jobId, rec.stepIndex);
        if (r) r.status = 'active';
        if (step.kind === 'transport') {
          const batch = S.batches.get(`B-${rec.jobId}`);
          if (batch) batch.status = 'loaded'; // 粮食已装载,交接链必须走到明确去向
        }
        break;
      }
      case 'step_done': {
        const job = S.jobs.get(rec.jobId);
        const step = job.steps[rec.stepIndex];
        step.status = 'done';
        const r = this._reservationOf(rec.jobId, rec.stepIndex);
        if (r) r.status = 'done';
        const batchId = `B-${rec.jobId}`;
        if (step.kind === 'harvest') {
          const plot = S.plots.get(job.plotId);
          S.batches.set(batchId, {
            id: batchId,
            jobId: job.id,
            plotId: plot.id,
            coopId: plot.coopId,
            weight: plot.expectedYield,
            status: 'harvested',
            moistureRecords: [],
            confirmed: false,
          });
        } else if (step.kind === 'transport') {
          S.batches.get(batchId).status = 'unloaded';
        } else if (step.kind === 'dry') {
          S.batches.get(batchId).status = 'dried';
        } else if (step.kind === 'store') {
          S.batches.get(batchId).status = 'stored';
          job.status = 'done';
        }
        break;
      }
      case 'weighed':
        S.batches.get(rec.batchId).weight = rec.weight;
        break;
      case 'quality_retest':
        S.batches.get(rec.batchId).moistureRecords.push({
          moisture: rec.moisture,
          at: rec.at,
          by: rec.actorId,
        });
        break;
      case 'equipment_down':
        S.equipment.get(rec.equipmentId).downIntervals.push({
          start: rec.at,
          end: rec.until ?? null,
        });
        S.equipment.get(rec.equipmentId).down = true;
        break;
      case 'equipment_up': {
        const eq = S.equipment.get(rec.equipmentId);
        const open = eq.downIntervals.find((d) => d.end === null);
        if (open) open.end = rec.at;
        eq.down = false;
        break;
      }
      case 'rain_stop':
        S.rainIntervals.push({ start: rec.at, end: null });
        break;
      case 'rain_resume': {
        const open = S.rainIntervals.find((r) => r.end === null);
        if (open) open.end = rec.at;
        break;
      }
      case 'cross_village_dispatch':
        S.equipment.get(rec.equipmentId).village = rec.toVillage;
        break;
      case 'batch_confirmed':
        S.batches.get(rec.batchId).confirmed = true;
        break;
      default:
        break; // 未知记录忽略,保证旧版本日志可以重放
    }
  }

  _reservationOf(jobId, stepIndex) {
    let found = null;
    for (const r of this.state.reservations.values()) {
      if (r.jobId === jobId && r.stepIndex === stepIndex && r.status !== 'released') found = r;
    }
    return found;
  }

  _plot(plotId) {
    const plot = this.state.plots.get(plotId);
    if (!plot) throw new StateError(`地块未登记: ${plotId}`);
    return plot;
  }

  _equipment(equipmentId) {
    const eq = this.state.equipment.get(equipmentId);
    if (!eq) throw new StateError(`设备不存在: ${equipmentId}`);
    return eq;
  }

  _job(jobId) {
    const job = this.state.jobs.get(jobId);
    if (!job) throw new StateError(`作业不存在: ${jobId}`);
    return job;
  }

  _batch(batchId) {
    const batch = this.state.batches.get(batchId);
    if (!batch) throw new StateError(`批次不存在: ${batchId}`);
    return batch;
  }

  // ---- 登记 ----

  async registerPlot(actor, plot) {
    if (actor?.role === 'coop') {
      if (plot.coopId !== actor.coopId)
        throw new PermissionError('合作社只能登记自己的地块');
    } else {
      needRole(actor, ['dispatcher'], '只有调度员或本社合作社可以登记地块');
    }
    const required = ['id', 'coopId', 'maturity', 'slope', 'expectedYield', 'accessibleEquipment', 'deadline'];
    if (required.some((k) => plot[k] === undefined) || !Array.isArray(plot.accessibleEquipment))
      throw new StateError('地块登记需包含成熟度、坡度、预计产量、可达设备与最晚完成时间');
    if (this.state.plots.has(plot.id)) throw new StateError(`地块已登记: ${plot.id}`);
    await this._commit({ type: 'plot_registered', plot });
    return plot;
  }

  async registerEquipment(actor, equipment) {
    needRole(actor, ['dispatcher'], '只有调度员可以登记设备');
    if (!['harvester', 'monorail', 'dryer'].includes(equipment.kind))
      throw new StateError(`未知设备类型: ${equipment.kind}`);
    if (equipment.kind === 'monorail' && !Array.isArray(equipment.sections))
      throw new StateError('单轨运输车需登记区段与载重');
    if (equipment.kind === 'dryer' && !Array.isArray(equipment.bins))
      throw new StateError('烘干线需登记仓位与容量');
    if (this.state.equipment.has(equipment.id))
      throw new StateError(`设备已登记: ${equipment.id}`);
    await this._commit({ type: 'equipment_registered', equipment });
    return equipment;
  }

  // ---- 作业计划 ----

  _checkStepTargets(step) {
    const eq = this.state.equipment.get(step.equipmentId);
    if (!eq) throw new StateError(`设备不存在: ${step.equipmentId}`);
    if (eq.kind !== STEP_EQUIPMENT_KIND[step.kind])
      throw new StateError(`设备类型不符: ${step.equipmentId}`);
    return eq;
  }

  // 交接链:收割开始、入库(明确去向)结束,环节顺序不乱、时间不重叠。
  _checkChain(plot, steps) {
    if (steps[0].kind !== 'harvest') throw new StateError('交接链必须从收割开始');
    const last = steps[steps.length - 1];
    if (last.kind !== 'store' || !last.destination)
      throw new StateError('交接链必须以明确去向的入库结束');
    let order = -1;
    let prev = null;
    for (const step of steps) {
      const o = KIND_ORDER[step.kind];
      if (o === undefined) throw new StateError(`未知环节: ${step.kind}`);
      if (o < order) throw new StateError('交接链环节顺序混乱');
      order = o;
      if (step.kind !== 'store') this._checkStepTargets(step);
      if (!(at(step.start) < at(step.end))) throw new StateError('环节时间窗口无效');
      if (prev && at(prev.end) > at(step.start)) throw new StateError('交接链环节时间重叠');
      prev = step;
      if (step.kind === 'harvest' && !plot.accessibleEquipment.includes(step.equipmentId))
        throw new StateError('收割设备不在地块可达范围内');
      if (step.kind === 'dry' && step.hours && at(step.end) - at(step.start) < step.hours * 3600e3)
        throw new StateError('烘干连续处理时长不足');
    }
  }

  // 事务裁决:任一候选预约冲突则整体拒绝,不留下半份预约。
  _checkCandidates(cands, ignoreIds = new Set()) {
    const active = [...this.state.reservations.values()].filter(
      (r) => (r.status === 'held' || r.status === 'active') && !ignoreIds.has(r.id)
    );
    for (const c of cands) {
      const eq = this._equipment(c.equipmentId);
      for (const d of eq.downIntervals)
        if (overlaps(c, d)) throw new ConflictError(`设备停机期间不可预约: ${c.equipmentId}`);
      if (c.kind === 'harvest' || c.kind === 'transport')
        for (const r of this.state.rainIntervals)
          if (overlaps(c, r)) throw new ConflictError('降雨停工期间不可安排户外作业');
      if (c.kind === 'transport') {
        const section = eq.sections.find((s) => s.id === c.sectionId);
        if (!section) throw new StateError(`单轨区段不存在: ${c.sectionId}`);
        if (c.load > section.capacity) throw new ConflictError(`超出单轨区段载重: ${c.sectionId}`);
      }
      if (c.kind === 'dry') {
        const bin = eq.bins.find((b) => b.id === c.binId);
        if (!bin) throw new StateError(`烘干仓不存在: ${c.binId}`);
        if (c.load > bin.capacity) throw new ConflictError(`超出烘干仓容量: ${c.binId}`);
      }
    }
    // 互斥:收割机整机、单轨区段同一时刻只允许一个作业
    const exclusive = [...active, ...cands].filter((r) => r.kind !== 'dry');
    for (const c of cands.filter((r) => r.kind !== 'dry')) {
      const key = resourceKeyOf(c);
      const clash = exclusive.find((r) => r !== c && resourceKeyOf(r) === key && overlaps(r, c));
      if (clash) throw new ConflictError(`资源互斥冲突: ${key}`);
    }
    // 烘干仓:重叠预约的同时在仓量不得超过仓容量
    const byBin = new Map();
    for (const r of [...active, ...cands].filter((r) => r.kind === 'dry')) {
      const key = resourceKeyOf(r);
      if (!byBin.has(key)) byBin.set(key, []);
      byBin.get(key).push(r);
    }
    for (const [key, list] of byBin) {
      const [equipmentId, binId] = key.split('/');
      const bin = this.state.equipment.get(equipmentId).bins.find((b) => b.id === binId);
      if (maxConcurrentLoad(list) > bin.capacity)
        throw new ConflictError(`烘干仓容量超限: ${key}`);
    }
  }

  async createJob(actor, { id, plotId, steps }) {
    needRole(actor, ['dispatcher'], '只有调度员可以制定作业计划');
    if (this.state.jobs.has(id)) throw new StateError(`作业已存在: ${id}`);
    const plot = this._plot(plotId);
    if (!Array.isArray(steps) || steps.length < 2)
      throw new StateError('交接链至少需要收割与入库两步');
    this._checkChain(plot, steps);
    const reservations = [];
    steps.forEach((step, i) => {
      if (step.kind === 'store') return;
      reservations.push({
        id: `${id}#${i}`,
        jobId: id,
        stepIndex: i,
        kind: step.kind,
        equipmentId: step.equipmentId,
        sectionId: step.sectionId,
        binId: step.binId,
        start: step.start,
        end: step.end,
        load: step.load ?? 0,
        status: 'held',
      });
    });
    this._checkCandidates(reservations);
    const job = {
      id,
      plotId,
      coopId: plot.coopId,
      status: 'planned',
      steps: steps.map((s) => ({ ...s, status: 'planned' })),
    };
    await this._commit({ type: 'job_created', job, reservations });
    return job;
  }

  // 独立资源预约(如临时抢占仓位):整批成功或整批拒绝。
  async reserve(actor, requests) {
    needRole(actor, ['dispatcher'], '只有调度员可以发起资源预约');
    if (!Array.isArray(requests) || requests.length === 0)
      throw new StateError('预约请求不能为空');
    const reservations = requests.map((r, i) => ({
      ...r,
      id: r.id ?? `R-${this.state.seq + 1}-${i}`,
      jobId: r.jobId ?? null,
      status: 'held',
    }));
    for (const r of reservations) {
      if (this.state.reservations.has(r.id)) throw new StateError(`预约号重复: ${r.id}`);
      this._checkStepTargets(r);
    }
    this._checkCandidates(reservations);
    await this._commit({ type: 'reservations_committed', reservations });
    return reservations;
  }

  // ---- 作业执行 ----

  async startStep(actor, jobId, stepIndex) {
    needRole(actor, ['dispatcher', 'operator'], '只有调度员或设备操作人员可以启动环节');
    const job = this._job(jobId);
    const step = job.steps[stepIndex];
    if (!step || step.status !== 'planned') throw new StateError('环节不在可启动状态');
    if (stepIndex > 0 && job.steps[stepIndex - 1].status !== 'done')
      throw new StateError('上一环节尚未完成');
    if (step.equipmentId) {
      const eq = this._equipment(step.equipmentId);
      if (eq.down) throw new ConflictError(`设备停机隔离中: ${eq.id}`);
    }
    if (
      (step.kind === 'harvest' || step.kind === 'transport') &&
      this.state.rainIntervals.some((r) => r.end === null)
    )
      throw new ConflictError('降雨停工中');
    await this._commit({ type: 'step_started', jobId, stepIndex });
  }

  async finishStep(actor, jobId, stepIndex) {
    needRole(actor, ['dispatcher', 'operator'], '只有调度员或设备操作人员可以完成环节');
    const job = this._job(jobId);
    const step = job.steps[stepIndex];
    if (!step || step.status !== 'active') throw new StateError('环节不在进行中');
    await this._commit({ type: 'step_done', jobId, stepIndex });
  }

  // ---- 事件追加(按发生顺序) ----

  async recordEvent(actor, event) {
    if (event.type === 'quality_retest') {
      needRole(actor, ['qc'], '只有质检人员可以独立记录品质复测');
      this._batch(event.batchId);
    } else if (event.type === 'weighed') {
      needRole(actor, ['operator', 'dispatcher'], '只有设备操作人员或调度员可以记录称重');
      this._batch(event.batchId);
    } else if (['equipment_down', 'equipment_up', 'cross_village_dispatch'].includes(event.type)) {
      needRole(actor, ['dispatcher'], '只有调度员可以记录该类事件');
      const eq = this._equipment(event.equipmentId);
      if (event.type === 'equipment_down' && eq.down) throw new ConflictError('设备已处于停机状态');
      if (event.type === 'equipment_up' && !eq.down) throw new StateError('设备不在停机状态');
    } else if (['rain_stop', 'rain_resume'].includes(event.type)) {
      needRole(actor, ['dispatcher'], '只有调度员可以记录该类事件');
      const raining = this.state.rainIntervals.some((r) => r.end === null);
      if (event.type === 'rain_stop' && raining) throw new ConflictError('已处于降雨停工状态');
      if (event.type === 'rain_resume' && !raining) throw new StateError('当前不在降雨停工状态');
    } else {
      throw new StateError(`未知事件类型: ${event.type}`);
    }
    await this._commit({ ...event, actorId: actor.id });
  }

  // ---- 临时改派:只释放尚未开始的资源,已装载粮食必须沿交接链到达明确去向 ----

  async reassign(actor, jobId, newSteps) {
    needRole(actor, ['dispatcher'], '只有调度员可以处理全局改派');
    const job = this._job(jobId);
    if (job.status === 'done') throw new StateError('作业已完成,不可改派');
    const firstPlanned = job.steps.findIndex((s) => s.status === 'planned');
    if (firstPlanned === -1) throw new StateError('没有可改派的未开始环节');
    const kept = job.steps.slice(0, firstPlanned); // 已开始或已完成的环节不可更改
    const replacement = newSteps.slice(kept.length).map((s) => ({ ...s, status: 'planned' }));
    const chain = [...kept, ...replacement];
    const plot = this._plot(job.plotId);
    this._checkChain(plot, chain); // 新链仍须以入库结束,已装载粮食才有明确去向
    const releasedIds = [...this.state.reservations.values()]
      .filter((r) => r.jobId === jobId && r.status === 'held')
      .map((r) => r.id);
    const candidates = [];
    replacement.forEach((step, i) => {
      if (step.kind === 'store') return;
      candidates.push({
        id: `${jobId}#r${this.state.seq + 1}-${i}`,
        jobId,
        stepIndex: kept.length + i,
        kind: step.kind,
        equipmentId: step.equipmentId,
        sectionId: step.sectionId,
        binId: step.binId,
        start: step.start,
        end: step.end,
        load: step.load ?? 0,
        status: 'held',
      });
    });
    this._checkCandidates(candidates, new Set(releasedIds));
    await this._commit({ type: 'job_reassigned', jobId, steps: chain, releasedIds, reservations: candidates });
    return this._job(jobId);
  }

  // ---- 确认与质检 ----

  async confirmPlot(actor, plotId) {
    const plot = this._plot(plotId);
    if (actor?.role !== 'coop' || actor.coopId !== plot.coopId)
      throw new PermissionError('合作社只能确认自己的地块');
    await this._commit({ type: 'plot_confirmed', plotId });
  }

  async confirmBatch(actor, batchId) {
    const batch = this._batch(batchId);
    if (actor?.role !== 'coop' || actor.coopId !== batch.coopId)
      throw new PermissionError('合作社只能确认自己的批次');
    await this._commit({ type: 'batch_confirmed', batchId });
  }

  // ---- 调度查询 ----

  // 每批稻谷当前在哪、下一台设备(或入库去向)是谁。
  batchStatus(batchId) {
    const batch = this._batch(batchId);
    const job = this._job(batch.jobId);
    const active = job.steps.find((s) => s.status === 'active');
    const lastDone = [...job.steps].reverse().find((s) => s.status === 'done');
    const nextStep = job.steps.find((s) => s.status === 'planned');
    const current = active ?? lastDone ?? null;
    return {
      batchId,
      status: batch.status,
      weight: batch.weight,
      location: current
        ? { kind: current.kind, equipmentId: current.equipmentId ?? null, destination: current.destination ?? null }
        : null,
      next: nextStep
        ? { kind: nextStep.kind, equipmentId: nextStep.equipmentId ?? null, destination: nextStep.destination ?? null }
        : null,
    };
  }

  // 延期影响了哪些地块:未完成作业的预计完成时间超过地块最晚完成时间。
  delayImpact() {
    const out = [];
    for (const job of this.state.jobs.values()) {
      if (job.status === 'done') continue;
      const plot = this.state.plots.get(job.plotId);
      const end = Math.max(...job.steps.map((s) => at(s.end)));
      if (end > at(plot.deadline))
        out.push({
          plotId: plot.id,
          jobId: job.id,
          projectedEnd: new Date(end).toISOString(),
          deadline: plot.deadline,
        });
    }
    return out;
  }

  // 某台设备(故障、调机)当前影响哪些作业与地块。
  equipmentImpact(equipmentId) {
    this._equipment(equipmentId);
    const jobIds = new Set();
    for (const r of this.state.reservations.values())
      if (r.equipmentId === equipmentId && (r.status === 'held' || r.status === 'active'))
        jobIds.add(r.jobId);
    return [...jobIds].filter(Boolean).map((jobId) => {
      const job = this.state.jobs.get(jobId);
      return { jobId, plotId: job.plotId, status: job.status };
    });
  }

  // 最终是否达到安全储存标准(以质检人员最近一次记录为准)。
  storageCheck(batchId) {
    const batch = this._batch(batchId);
    const latest = batch.moistureRecords[batch.moistureRecords.length - 1] ?? null;
    return {
      batchId,
      status: batch.status,
      moisture: latest ? latest.moisture : null,
      safe: latest ? latest.moisture <= SAFE_MOISTURE : false,
    };
  }

  // 某资源上的排队顺序(按预约先后)。
  queueOf(resourceKey) {
    return [...this.state.reservations.values()]
      .filter((r) => resourceKeyOf(r) === resourceKey && (r.status === 'held' || r.status === 'active'))
      .sort((a, b) => a.order - b.order)
      .map((r) => ({ id: r.id, jobId: r.jobId, start: r.start, end: r.end, status: r.status }));
  }

  // 故障隔离中的设备。
  isolatedEquipment() {
    return [...this.state.equipment.values()].filter((eq) => eq.down).map((eq) => eq.id);
  }
}
