import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { HarvestService, ROLES } from '../src/service.js';
import { createClock, HOUR, MINUTE } from '../src/clock.js';
import { traceBatch, delayImpact, storageReport, equipmentBoard } from '../src/queries.js';
import { SAFE_MOISTURE } from '../src/planner.js';

const T0 = Date.UTC(2026, 8, 20, 0, 0, 0);
const DAY = 24 * HOUR;
const SHIFTS = [{ start: 6 * HOUR, end: 18 * HOUR }];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'harvest-'));
  const path = join(dir, 'log.jsonl');
  const clock = createClock(T0);
  let seq = 0;
  const tx = (p = 'tx') => `${p}-${(seq += 1)}`;
  const open = () => {
    const store = new EventStore(path);
    const svc = new HarvestService(store, clock);
    return { dir, path, clock, store, svc, get state() { return store.state; }, tx };
  };
  const h = open();
  h.reopen = open;
  h.cleanup = () => rmSync(dir, { recursive: true, force: true });
  return h;
}

const disp = { role: ROLES.dispatcher };
const coopA = { role: ROLES.coop, coop: '甲村合作社' };
const coopB = { role: ROLES.coop, coop: '乙村合作社' };
const qa = { role: ROLES.quality, who: '质检-林' };
const op = { role: ROLES.operator };

function standardFleet(svc, tx) {
  svc.registerEquipment(tx(), disp, { id: 'H1', kind: 'harvester', maxSlope: 25, shifts: SHIFTS });
  svc.registerEquipment(tx(), disp, { id: 'H2', kind: 'harvester', maxSlope: 15, shifts: SHIFTS });
  svc.registerEquipment(tx(), disp, { id: 'M1', kind: 'monorail', capacityKg: 1000 });
  svc.registerEquipment(tx(), disp, { id: 'M2', kind: 'monorail', capacityKg: 800 });
  svc.registerEquipment(tx(), disp, { id: 'D1', kind: 'dryer', capacityKg: 10_000 });
  svc.registerEquipment(tx(), disp, { id: 'D2', kind: 'dryer', capacityKg: 10_000 });
}

function plot(svc, tx, id, coop, overrides = {}) {
  svc.registerPlot(tx(), { role: ROLES.coop, coop }, {
    id,
    maturity: 3,
    slope: 12,
    yieldKg: 1500,
    deadline: T0 + 2 * DAY,
    accessible: ['H1', 'H2'],
    ...overrides,
  });
  svc.confirmPlot(tx(), { role: ROLES.coop, coop }, id);
}

function chainOf(svc, batchId) {
  return [...svc.state.bookings.values()].filter((b) => b.batchId === batchId);
}

test('登记与权限：合作社只能确认自己的地块，未确认不能排产', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  h.svc.registerPlot(h.tx(), coopA, {
    id: 'P1', maturity: 3, slope: 12, yieldKg: 1500, deadline: T0 + 2 * DAY, accessible: ['H1'],
  });

  assert.throws(() => h.svc.confirmPlot(h.tx(), coopB, 'P1'), /自己的地块/);
  assert.throws(
    () => h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' }),
    /确认/
  );
  h.svc.confirmPlot(h.tx(), coopA, 'P1');
  h.cleanup();
});

test('登记校验：坡度、产量、最晚完成时间、可达设备', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  const mk = (o) => h.svc.registerPlot(h.tx(), coopA, {
    id: 'PX', maturity: 3, slope: 12, yieldKg: 1000, deadline: T0 + DAY, accessible: ['H1'], ...o,
  });
  assert.throws(() => mk({ slope: -1 }), /坡度/);
  assert.throws(() => mk({ yieldKg: 0 }), /产量/);
  assert.throws(() => mk({ deadline: T0 - 1 }), /最晚完成时间/);
  assert.throws(() => mk({ accessible: [] }), /可达/);
  assert.throws(() => mk({ maturity: 9 }), /成熟度/);
  assert.throws(() => h.svc.registerEquipment(h.tx(), op, { id: 'X', kind: 'dryer' }), /无权/);
  h.cleanup();
});

test('交接链整体建立：每批粮食自始就有明确烘干去向，并按载重自动分趟', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社', { yieldKg: 2500 });
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  const batch = h.svc.state.batches.get(c.batchId);
  assert.equal(batch.destination, 'D1');
  assert.equal(c.transportBookingIds.length, 3); // 2500kg / 1000kg 上取整
  const trips = chainOf(h.svc, c.batchId).filter((b) => b.stage === 'transport').sort((a, b) => a.trip - b.trip);
  assert.deepEqual(trips.map((t) => t.tripKg), [1000, 1000, 500]);
  // 链式依赖：收割→趟1→趟2→趟3→烘干
  assert.equal(trips[0].dependsOn, c.harvestBookingId);
  assert.equal(trips[2].dependsOn, trips[1].id);
  const dry = h.svc.state.bookings.get(c.dryBookingId);
  assert.equal(dry.dependsOn, trips[2].id);
  h.cleanup();
});

test('约束失败不留半份预约：烘干仓容量不足时整条链不产生任何事件', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  h.svc.registerEquipment(h.tx(), disp, { id: 'DS', kind: 'dryer', capacityKg: 500 });
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  const before = h.svc.state.bookings.size;
  assert.throws(
    () => h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'DS' }),
    /容量/
  );
  assert.equal(h.svc.state.bookings.size, before);
  assert.equal(h.svc.state.batches.size, 0);
  h.cleanup();
});

test('收割机班次：作业只排进班次时段', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社', { yieldKg: 1200 });
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  const hv = h.svc.state.bookings.get(c.harvestBookingId);
  const h0 = new Date(hv.start);
  const h1 = new Date(hv.end);
  assert.ok(h0.getUTCHours() >= 6 && h1.getUTCHours() <= 18);
  h.cleanup();
});

test('FIFO 与互斥：先申请者先得早时段，同设备预约互不重叠', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  plot(h.svc, h.tx, 'P2', '乙村合作社');
  const c1 = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  const c2 = h.svc.requestChain(h.tx(), coopB, { plotId: 'P2', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  const b1 = h.svc.state.bookings.get(c1.harvestBookingId);
  const b2 = h.svc.state.bookings.get(c2.harvestBookingId);
  assert.ok(b1.start < b2.start);
  assert.ok(b1.end <= b2.start); // 不重叠
  // 单轨区段同样互斥：P2 的首趟不得早于 P1 全部转运结束
  const m1 = chainOf(h.svc, c1.batchId).filter((b) => b.stage === 'transport');
  const m2first = chainOf(h.svc, c2.batchId).filter((b) => b.stage === 'transport').sort((a, b) => a.trip - b.trip)[0];
  const m1End = Math.max(...m1.map((b) => b.end));
  assert.ok(m2first.start >= m1End);
  h.cleanup();
});

test('坡度超限的预约受阻但不堵队：后续地块可越过使用该收割机', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'STEEP', '甲村合作社', { slope: 22, accessible: ['H2'] });
  plot(h.svc, h.tx, 'FLAT', '乙村合作社', { slope: 10, accessible: ['H2'] });
  const cSteep = h.svc.requestChain(h.tx(), coopA, { plotId: 'STEEP', harvesterId: 'H2', monorailId: 'M1', dryerId: 'D1' });
  const cFlat = h.svc.requestChain(h.tx(), coopB, { plotId: 'FLAT', harvesterId: 'H2', monorailId: 'M1', dryerId: 'D1' });
  const steepB = h.svc.state.bookings.get(cSteep.harvestBookingId);
  const flatB = h.svc.state.bookings.get(cFlat.harvestBookingId);
  assert.equal(steepB.status, 'blocked');
  assert.match(steepB.blockedReason, /坡度/);
  assert.equal(flatB.status, 'booked'); // 越过受阻预约
  h.cleanup();
});

test('实际称重增趟：已装载趟次锁定，新增趟次接尾且烘干依赖顺延', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社', { yieldKg: 800 });
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  assert.equal(c.transportBookingIds.length, 1);
  const hvEnd = h.svc.state.bookings.get(c.harvestBookingId).end;
  h.clock.set(hvEnd + 5 * MINUTE);
  h.svc.wake(); // 收割完成、唯一一趟已开行（已装载 800kg）
  const t1 = h.svc.state.bookings.get(c.transportBookingIds[0]);
  assert.equal(t1.status, 'running');
  h.svc.weighBatch(h.tx(), op, c.batchId, 1600);
  const trips = chainOf(h.svc, c.batchId).filter((b) => b.stage === 'transport' && b.status !== 'cancelled').sort((a, b) => a.trip - b.trip);
  assert.equal(trips.length, 2);
  assert.equal(trips[0].tripKg, 800); // 已装载重量不动
  assert.equal(trips[1].tripKg, 800);
  assert.equal(trips[1].dependsOn, trips[0].id);
  const dry = h.svc.state.bookings.get(c.dryBookingId);
  assert.equal(dry.dependsOn, trips[1].id);
  h.cleanup();
});

test('实际称重核减：只取消未开始趟次，已装载粮食必须沿链走完', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社', { yieldKg: 2500 });
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  const hvEnd = h.svc.state.bookings.get(c.harvestBookingId).end;
  h.clock.set(hvEnd + 5 * MINUTE);
  h.svc.wake(); // 收割完，趟1开行
  h.svc.weighBatch(h.tx(), op, c.batchId, 1500);
  const trips = chainOf(h.svc, c.batchId).filter((b) => b.stage === 'transport').sort((a, b) => a.trip - b.trip);
  assert.equal(trips[0].status, 'running');
  assert.equal(trips[1].status, 'booked');
  assert.equal(trips[2].status, 'cancelled');
  assert.equal(trips[1].tripKg, 500);
  const dry = h.svc.state.bookings.get(c.dryBookingId);
  assert.equal(dry.dependsOn, trips[1].id);
  h.cleanup();
});

test('改派只能释放尚未开始的资源；已装载拒绝改派', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  // 尚未开始：收割预约可改派到 H2，H1 时段立即释放
  h.svc.reassignBooking(h.tx(), disp, c.harvestBookingId, 'H2');
  const moved = h.svc.state.bookings.get(c.harvestBookingId);
  assert.equal(moved.resourceId, 'H2');
  assert.equal(moved.status, 'booked');
  // 开行后改派转运：拒绝
  h.clock.set(h.svc.state.bookings.get(c.harvestBookingId).end + 5 * MINUTE);
  h.svc.wake();
  const t1 = h.svc.state.bookings.get(c.transportBookingIds[0]);
  assert.equal(t1.status, 'running');
  assert.throws(() => h.svc.reassignBooking(h.tx(), disp, t1.id, 'M2'), /已装载|已经开始/);
  // 非调度员不能改派
  assert.throws(() => h.svc.reassignBooking(h.tx(), op, c.dryBookingId, 'D2'), /无权/);
  h.cleanup();
});

test('设备故障：运行中作业打断并保留剩余工时，停机期间隔离，恢复后续跑', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社', { yieldKg: 1200 });
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  const hv = h.svc.state.bookings.get(c.harvestBookingId);
  const fullDur = hv.durationMs;
  h.clock.set(hv.start + 30 * MINUTE);
  h.svc.wake();
  assert.equal(hv.status, 'running');
  h.svc.reportDowntime(h.tx(), op, 'H1', '割台堵塞');
  assert.equal(hv.status, 'queued');
  assert.equal(h.svc.state.equipment.get('H1').down, true);
  assert.ok(hv.remainingMs > 0 && hv.remainingMs < fullDur);
  // 隔离期间不会被重新排上
  h.svc.wake();
  assert.notEqual(hv.status, 'booked');
  // 地块被登记延期
  assert.ok(delayImpact(h.svc.state).some((d) => d.plotId === 'P1'));
  // 恢复：只做剩余工时（resolveDowntime 内部立即重排，时段从恢复时刻起）
  h.clock.advance(2 * HOUR);
  h.svc.resolveDowntime(h.tx(), disp, 'H1');
  assert.equal(hv.status, 'booked');
  assert.equal(hv.end - hv.start, hv.remainingMs);
  h.svc.wake();
  assert.equal(hv.status, 'running');
  h.cleanup();
});

test('降雨停工：打断田间与单轨，仓内连续烘干不中断', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  h.svc.recordMoisture(h.tx(), qa, c.batchId, 'intake', 20);
  h.clock.set(T0 + 12 * HOUR);
  h.svc.wake(); // 收割、转运完成，烘干进行中
  const dry = h.svc.state.bookings.get(c.dryBookingId);
  assert.equal(dry.status, 'running');
  const dryEnd = dry.end;
  h.svc.recordRain(h.tx(), op);
  assert.equal(dry.status, 'running'); // 连续烘干不受影响
  assert.equal(dry.end, dryEnd);
  // 新排的田间作业被雨挡住
  plot(h.svc, h.tx, 'P2', '乙村合作社');
  const c2 = h.svc.requestChain(h.tx(), coopB, { plotId: 'P2', harvesterId: 'H1', monorailId: 'M2', dryerId: 'D1' });
  h.clock.advance(30 * MINUTE);
  h.svc.wake();
  const hv2 = h.svc.state.bookings.get(c2.harvestBookingId);
  assert.notEqual(hv2.status, 'running'); // 雨没停不开工
  h.svc.clearRain(h.tx(), op);
  h.svc.wake();
  assert.equal(hv2.status, 'running');
  h.cleanup();
});

test('跨村调机：离村期间设备不可用，回村后排队顺序不变', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  plot(h.svc, h.tx, 'P2', '乙村合作社');
  const c1 = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  const c2 = h.svc.requestChain(h.tx(), coopB, { plotId: 'P2', harvesterId: 'H1', monorailId: 'M2', dryerId: 'D1' });
  const hv1Start = h.svc.state.bookings.get(c1.harvestBookingId).start;
  // 班前半小时接到跨村调机指令，运输窗口覆盖 P1 的计划开工时刻
  h.clock.set(hv1Start - 30 * MINUTE);
  h.svc.transferEquipment(h.tx(), disp, 'H1', '邻县西坡村', 4 * HOUR);
  h.clock.set(hv1Start + 30 * MINUTE);
  h.svc.wake(); // 设备在调机途中：已排定的 P1 不能开工
  assert.notEqual(h.svc.state.bookings.get(c1.harvestBookingId).status, 'running');
  h.clock.set(hv1Start + 4 * HOUR);
  h.svc.wake(); // 回村（+3.5h）后已开工且尚未完工
  assert.equal(h.svc.state.bookings.get(c1.harvestBookingId).status, 'running');
  // P2 始终排在 P1 之后
  assert.ok(h.svc.state.bookings.get(c2.harvestBookingId).start >= h.svc.state.bookings.get(c1.harvestBookingId).end);
  h.cleanup();
});

test('连续烘干中断必须整批重做：复测解封后按完整时长重排', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  h.svc.recordMoisture(h.tx(), qa, c.batchId, 'intake', 24);
  h.clock.set(T0 + 13 * HOUR);
  h.svc.wake();
  const dry = h.svc.state.bookings.get(c.dryBookingId);
  assert.equal(dry.status, 'running');
  const fullDur = dry.durationMs;
  h.svc.reportDowntime(h.tx(), disp, 'D1', '热风炉故障');
  assert.equal(h.svc.state.batches.get(c.batchId).needRecheck, true);
  assert.equal(dry.status, 'blocked');
  assert.match(dry.blockedReason, /复测/);
  h.svc.resolveDowntime(h.tx(), disp, 'D1');
  h.svc.wake();
  assert.equal(dry.status, 'blocked'); // 没复测不能重开
  // 只有质检能复测
  assert.throws(() => h.svc.recordMoisture(h.tx(), disp, c.batchId, 'intake', 24), /无权/);
  h.svc.recordMoisture(h.tx(), qa, c.batchId, 'intake', 24);
  assert.equal(dry.status, 'booked'); // 复测解封后立即重排
  assert.equal(dry.end - dry.start, fullDur); // 完整重做而非续烘
  h.svc.wake();
  assert.equal(dry.status, 'running');
  h.cleanup();
});

test('安全入库：超标只记录复测不入库，返烘达标后入库', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  h.svc.recordMoisture(h.tx(), qa, c.batchId, 'intake', 20);
  h.clock.set(T0 + 20 * HOUR);
  h.svc.wake();
  assert.equal(h.svc.state.bookings.get(c.dryBookingId).status, 'done');
  // 超标
  const safe1 = h.svc.storeBatch(h.tx(), qa, c.batchId, 15.0);
  assert.equal(safe1, false);
  assert.equal(h.svc.state.batches.get(c.batchId).stored, false);
  // 调度员安排返烘
  const redryId = h.svc.requestRedry(h.tx(), disp, c.batchId);
  h.clock.set(T0 + 30 * HOUR);
  h.svc.wake();
  assert.equal(h.svc.state.bookings.get(redryId).status, 'done');
  const safe2 = h.svc.storeBatch(h.tx(), qa, c.batchId, 13.0);
  assert.equal(safe2, true);
  const report = storageReport(h.svc.state).find((r) => r.batchId === c.batchId);
  assert.equal(report.verdict, '达标入库');
  assert.equal(report.safeThreshold, SAFE_MOISTURE);
  h.cleanup();
});

test('查询接口：批次位置/下一设备、延期影响、设备看板', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  let tr = traceBatch(h.svc.state, c.batchId);
  assert.equal(tr.location, 'planned');
  assert.equal(tr.next.stage, 'harvest');
  assert.equal(tr.destinationName, 'D1');
  // 收割进行中单轨区段故障：收割照常完成，粮食堵在田间
  const hvStart = h.svc.state.bookings.get(c.harvestBookingId).start;
  h.clock.set(hvStart + 10 * MINUTE);
  h.svc.reportDowntime(h.tx(), op, 'M1', '牵引轮损坏');
  h.clock.set(h.svc.state.bookings.get(c.harvestBookingId).end + 5 * MINUTE);
  h.svc.wake();
  tr = traceBatch(h.svc.state, c.batchId);
  assert.equal(tr.location, 'field'); // 稻谷堵在田间
  assert.equal(tr.next.stage, 'transport'); // 下一台设备仍是故障的单轨
  assert.equal(tr.next.equipmentId, 'M1');
  const impact = delayImpact(h.svc.state);
  assert.ok(impact.some((d) => d.plotId === 'P1' && d.reasons.some((r) => r.includes('牵引轮'))));
  const board = equipmentBoard(h.svc.state).find((e) => e.equipmentId === 'M1');
  assert.equal(board.down, true);
  h.cleanup();
});

test('进程重启：重放日志后续跑到期作业，故障保持隔离，排队顺序保留', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  plot(h.svc, h.tx, 'P2', '乙村合作社');
  const c1 = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  const c2 = h.svc.requestChain(h.tx(), coopB, { plotId: 'P2', harvesterId: 'H1', monorailId: 'M2', dryerId: 'D1' });
  h.svc.reportDowntime(h.tx(), disp, 'H1', '发动机高温');

  // 模拟进程重启：新建存储重放日志
  const h2 = h.reopen();
  assert.equal(h2.svc.state.equipment.get('H1').down, true);
  // P1 的收割预约被打回队列且排在队首，顺序没有因重启改变
  const q = equipmentBoard(h2.svc.state).find((e) => e.equipmentId === 'H1').queue.map((x) => x.bookingId);
  assert.equal(q[0], c1.harvestBookingId);
  h2.clock.set(T0 + 9 * HOUR);
  h2.svc.resolveDowntime(h.tx(), disp, 'H1');
  h2.svc.wake();
  assert.equal(h2.svc.state.bookings.get(c1.harvestBookingId).status, 'running');
  h2.clock.set(T0 + 22 * HOUR);
  h2.svc.wake();
  assert.equal(h2.svc.state.bookings.get(c1.harvestBookingId).status, 'done');
  assert.ok(h2.svc.state.bookings.get(c2.harvestBookingId).start >= h2.svc.state.bookings.get(c1.harvestBookingId).end);
  h.cleanup();
});

test('事务原子性：末尾残行（崩溃）整体丢弃，重放后无半份预约', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  const c = h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  const batchesBefore = h.svc.state.batches.size;
  const txsBefore = h.store.txs.length;

  // 直接往日志尾部写一段残缺 JSON，模拟最后一个事务写了一半掉电
  appendFileSync(h.path, '{"txId":"broken","at":1,"events":[{"type":"PlotRegister');
  const reopened = h.reopen();
  assert.equal(reopened.store.txs.length, txsBefore);
  assert.equal(reopened.state.batches.size, batchesBefore);
  assert.ok(reopened.state.batches.has(c.batchId));
  // 损坏行之后的新事务仍可正常追加
  plot(h.svc, h.tx, 'P2', '乙村合作社');
  h.cleanup();
});

test('重复事务编号被拒绝', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  assert.throws(() => plot(h.svc, () => 'same-tx', 'P9', '甲村合作社'), /事务编号重复/);
  h.cleanup();
});

test('日志全部为完整 JSON 行', () => {
  const h = harness();
  standardFleet(h.svc, h.tx);
  plot(h.svc, h.tx, 'P1', '甲村合作社');
  h.svc.requestChain(h.tx(), coopA, { plotId: 'P1', harvesterId: 'H1', monorailId: 'M1', dryerId: 'D1' });
  for (const line of readFileSync(h.path, 'utf8').trim().split('\n')) {
    const tx = JSON.parse(line);
    assert.ok(Array.isArray(tx.events) && tx.events.length > 0);
  }
  h.cleanup();
});
