// 秋收协同服务端到端演示：不连接外部服务，使用临时日志与可控时钟。
// 运行：node examples/demo.mjs
import { rmSync } from 'node:fs';
import { EventStore } from '../src/store.js';
import { HarvestService, ROLES } from '../src/service.js';
import { createClock, HOUR, MINUTE } from '../src/clock.js';
import { traceBatch, delayImpact, storageReport, equipmentBoard } from '../src/queries.js';

const T0 = Date.UTC(2026, 8, 21, 0, 0, 0); // 2026-09-21 UTC
const clock = createClock(T0);
const LOG = '/tmp/terrace-demo.jsonl';
rmSync(LOG, { force: true });

let n = 0;
const tx = (p = 'tx') => `${p}-${(n += 1)}`;
const svc = new HarvestService(new EventStore(LOG), clock);

const dispatcher = { role: ROLES.dispatcher };
const coopA = { role: ROLES.coop, coop: '沿河梯田合作社' };
const operator = { role: ROLES.operator };
const quality = { role: ROLES.quality, who: '质检-韦' };

const say = (t) => console.log(`[${new Date(clock.now()).toISOString().slice(5, 16)}] ${t}`);

// 1. 调度员登记共用设备
svc.registerEquipment(tx(), dispatcher, { id: '收割机-03', kind: 'harvester', name: '3号联合收割机', maxSlope: 25, shifts: [{ start: 6 * HOUR, end: 18 * HOUR }] });
svc.registerEquipment(tx(), dispatcher, { id: '单轨-东坡', kind: 'monorail', name: '东坡单轨区段', capacityKg: 1000 });
svc.registerEquipment(tx(), dispatcher, { id: '烘干仓-1', kind: 'dryer', name: '1号烘干仓', capacityKg: 20000 });
svc.registerEquipment(tx(), dispatcher, { id: '烘干仓-2', kind: 'dryer', name: '2号烘干仓', capacityKg: 20000 });

// 2. 合作社登记地块（成熟度/坡度/预计产量/可达设备/最晚完成时间）并确认
svc.registerPlot(tx(), coopA, {
  id: '东坡-12', maturity: 3, slope: 14, yieldKg: 2400,
  deadline: T0 + 2 * 24 * HOUR, accessible: ['收割机-03'],
});
svc.confirmPlot(tx(), coopA, '东坡-12');

// 3. 整条交接链在一个事务内建立：收割→分趟转运→连续烘干，批次去向明确
const chain = svc.requestChain(tx(), coopA, {
  plotId: '东坡-12', harvesterId: '收割机-03', monorailId: '单轨-东坡', dryerId: '烘干仓-1',
});
say(`已排产批次 ${chain.batchId}：${chain.transportBookingIds.length} 趟转运，去向 1号烘干仓`);

// 4. 时间推进到收割完成，实际称重 2600kg → 自动追加一趟
clock.set(T0 + 8 * HOUR + 30 * MINUTE);
svc.wake();
say('收割完成，首趟单轨已开行并装载');
svc.weighBatch(tx(), operator, chain.batchId, 2600);
const trips = [...svc.state.bookings.values()].filter((b) => b.batchId === chain.batchId && b.stage === 'transport' && b.status !== 'cancelled');
say(`实际称重 2600kg，转运趟次调整为 ${trips.length} 趟（已装载趟次不动）`);

// 5. 入仓水分复测（质检独立操作），连续烘干时长按水分重算
svc.recordMoisture(tx(), quality, chain.batchId, 'intake', 24);
say('入仓水分 24%，连续烘干时长重算为整批处理计划');

// 6. 转运途中区段故障：在途粮食保留、后续趟次等待；恢复后继续
clock.set(T0 + 10 * HOUR);
svc.reportDowntime(tx(), operator, '单轨-东坡', '牵引轮异响');
say('单轨区段故障隔离，后续趟次排队等待');
clock.set(T0 + 12 * HOUR);
svc.resolveDowntime(tx(), dispatcher, '单轨-东坡');
say('故障排除，排队顺序恢复');

// 7. 推进到烘干
for (let t = T0 + 12 * HOUR; t < T0 + 26 * HOUR; t += 20 * MINUTE) {
  clock.set(t);
  svc.wake();
}
const dry = svc.state.bookings.get(chain.dryBookingId);
say(`烘干状态：${dry.status}`);

// 8. 入库水分复测：超标禁止入库，返烘后复测达标
let safe = svc.storeBatch(tx(), quality, chain.batchId, 14.4);
say(`首次复测 14.4% → ${safe ? '达标入库' : '超标，禁止入库，安排返烘'}`);
if (!safe) {
  const redryId = svc.requestRedry(tx(), dispatcher, chain.batchId);
  clock.set(T0 + 34 * HOUR);
  svc.wake();
  safe = svc.storeBatch(tx(), quality, chain.batchId, 13.1);
  say(`返烘后复测 13.1% → ${safe ? '达标入库' : '仍超标'}`);
}

// 9. 查询：批次在哪、下一台设备、延期影响、安全储存结论
const trace = traceBatch(svc.state, chain.batchId);
console.log('\n— 批次追踪 —');
console.log(JSON.stringify({
  batchId: trace.batchId, location: trace.location, destination: trace.destinationName,
  stored: trace.stored, safe: trace.safe,
  moisture: { intake: trace.moistureIntake, final: trace.moistureFinal },
}, null, 2));

console.log('— 延期影响地块 —');
console.log(delayImpact(svc.state).map((d) => ({ plotId: d.plotId, reasons: d.reasons, stillLate: d.stillLate })));

console.log('— 安全储存报告 —');
console.log(storageReport(svc.state));

console.log('— 设备看板（队列顺序）—');
for (const e of equipmentBoard(svc.state)) {
  console.log(`${e.name}：${e.down ? '停机隔离' : '可用'}，排队 ${e.queue.length} 单`);
}
