import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConflictError,
  HarvestService,
  PermissionError,
  StateError,
} from '../src/service.js';

const dispatcher = { id: 'D1', role: 'dispatcher' };
const coopA = { id: 'C1', role: 'coop', coopId: 'coop-a' };
const coopB = { id: 'C2', role: 'coop', coopId: 'coop-b' };
const operator = { id: 'O1', role: 'operator' };
const qc = { id: 'Q1', role: 'qc' };

async function makeService() {
  const dir = await mkdtemp(join(tmpdir(), 'harvest-'));
  const path = join(dir, 'events.jsonl');
  const service = await HarvestService.open(path);
  return { service, path };
}

async function seed(service) {
  await service.registerEquipment(dispatcher, { id: 'H1', kind: 'harvester', village: '上村' });
  await service.registerEquipment(dispatcher, { id: 'H2', kind: 'harvester', village: '下村' });
  await service.registerEquipment(dispatcher, {
    id: 'M1',
    kind: 'monorail',
    village: '上村',
    sections: [
      { id: 'S1', capacity: 5 },
      { id: 'S2', capacity: 5 },
    ],
  });
  await service.registerEquipment(dispatcher, {
    id: 'DR1',
    kind: 'dryer',
    village: '镇上',
    bins: [
      { id: 'B1', capacity: 10 },
      { id: 'B2', capacity: 10 },
    ],
  });
  await service.registerPlot(coopA, {
    id: 'P1',
    coopId: 'coop-a',
    maturity: '2026-09-25',
    slope: 15,
    expectedYield: 4,
    accessibleEquipment: ['H1', 'H2'],
    deadline: '2026-09-28T00:00:00.000Z',
  });
}

const J1_STEPS = [
  { kind: 'harvest', equipmentId: 'H1', start: '2026-09-26T01:00:00.000Z', end: '2026-09-26T03:00:00.000Z' },
  { kind: 'transport', equipmentId: 'M1', sectionId: 'S1', load: 4, start: '2026-09-26T03:00:00.000Z', end: '2026-09-26T04:00:00.000Z' },
  { kind: 'dry', equipmentId: 'DR1', binId: 'B1', load: 4, hours: 8, start: '2026-09-26T04:00:00.000Z', end: '2026-09-26T14:00:00.000Z' },
  { kind: 'store', destination: '中心粮库1号仓', start: '2026-09-26T14:00:00.000Z', end: '2026-09-26T15:00:00.000Z' },
];

test('地块登记与作业计划:校验可达设备、交接链与连续烘干时长', async () => {
  const { service } = await makeService();
  await seed(service);
  const job = await service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS });
  assert.equal(job.status, 'planned');
  assert.equal(service.state.reservations.size, 3); // 入库环节不占设备

  await assert.rejects(
    service.registerPlot(coopA, { id: 'P2', coopId: 'coop-b', maturity: '2026-09-25', slope: 10, expectedYield: 3, accessibleEquipment: ['H1'], deadline: '2026-09-28T00:00:00.000Z' }),
    PermissionError
  );
  await assert.rejects(
    service.createJob(dispatcher, {
      id: 'J2',
      plotId: 'P1',
      steps: [
        { kind: 'harvest', equipmentId: 'M1', start: '2026-09-27T01:00:00.000Z', end: '2026-09-27T02:00:00.000Z' },
        { kind: 'store', destination: '中心粮库1号仓', start: '2026-09-27T02:00:00.000Z', end: '2026-09-27T03:00:00.000Z' },
      ],
    }),
    /设备类型不符/
  );
  await assert.rejects(
    service.createJob(dispatcher, {
      id: 'J3',
      plotId: 'P1',
      steps: [
        { kind: 'harvest', equipmentId: 'H2', start: '2026-09-27T01:00:00.000Z', end: '2026-09-27T02:00:00.000Z' },
        { kind: 'dry', equipmentId: 'DR1', binId: 'B2', load: 4, start: '2026-09-27T02:00:00.000Z', end: '2026-09-27T10:00:00.000Z' },
      ],
    }),
    /明确去向/
  );
  await assert.rejects(
    service.createJob(dispatcher, {
      id: 'J4',
      plotId: 'P1',
      steps: [
        { kind: 'harvest', equipmentId: 'H2', start: '2026-09-27T01:00:00.000Z', end: '2026-09-27T02:00:00.000Z' },
        { kind: 'dry', equipmentId: 'DR1', binId: 'B2', load: 4, hours: 12, start: '2026-09-27T02:00:00.000Z', end: '2026-09-27T10:00:00.000Z' },
        { kind: 'store', destination: '中心粮库1号仓', start: '2026-09-27T10:00:00.000Z', end: '2026-09-27T11:00:00.000Z' },
      ],
    }),
    /连续处理时长不足/
  );
});

test('事务裁决:抢占同一设备的请求整体拒绝,不留下半份预约', async () => {
  const { service } = await makeService();
  await seed(service);
  await service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS });
  await service.registerPlot(dispatcher, {
    id: 'P2',
    coopId: 'coop-b',
    maturity: '2026-09-25',
    slope: 20,
    expectedYield: 3,
    accessibleEquipment: ['H1'],
    deadline: '2026-09-28T00:00:00.000Z',
  });
  const before = service.state.reservations.size;
  // 收割机 H1 在 02:00-04:00 与 J1 的 01:00-03:00 重叠
  await assert.rejects(
    service.createJob(dispatcher, {
      id: 'J2',
      plotId: 'P2',
      steps: [
        { kind: 'harvest', equipmentId: 'H1', start: '2026-09-26T02:00:00.000Z', end: '2026-09-26T04:00:00.000Z' },
        { kind: 'store', destination: '中心粮库2号仓', start: '2026-09-26T04:00:00.000Z', end: '2026-09-26T05:00:00.000Z' },
      ],
    }),
    ConflictError
  );
  assert.equal(service.state.reservations.size, before);
  assert.equal(service.state.jobs.has('J2'), false);

  // 一次多请求:第二个请求冲突,第一个也不生效
  await assert.rejects(
    service.reserve(dispatcher, [
      { id: 'X1', kind: 'dry', equipmentId: 'DR1', binId: 'B2', load: 5, start: '2026-09-26T04:00:00.000Z', end: '2026-09-26T12:00:00.000Z' },
      { id: 'X2', kind: 'transport', equipmentId: 'M1', sectionId: 'S1', load: 3, start: '2026-09-26T03:30:00.000Z', end: '2026-09-26T05:00:00.000Z' },
    ]),
    /互斥冲突/
  );
  assert.equal(service.state.reservations.has('X1'), false);
  assert.equal(service.state.reservations.has('X2'), false);
});

test('单轨区段互斥运行与载重上限', async () => {
  const { service } = await makeService();
  await seed(service);
  await service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS });
  await assert.rejects(
    service.reserve(dispatcher, [
      { kind: 'transport', equipmentId: 'M1', sectionId: 'S1', load: 6, start: '2026-09-26T05:00:00.000Z', end: '2026-09-26T06:00:00.000Z' },
    ]),
    /载重/
  );
  await assert.rejects(
    service.reserve(dispatcher, [
      { kind: 'transport', equipmentId: 'M1', sectionId: 'S1', load: 3, start: '2026-09-26T03:30:00.000Z', end: '2026-09-26T05:00:00.000Z' },
    ]),
    /互斥冲突/
  );
  // 不同区段同一时刻可以并行
  const ok = await service.reserve(dispatcher, [
    { kind: 'transport', equipmentId: 'M1', sectionId: 'S2', load: 3, start: '2026-09-26T03:30:00.000Z', end: '2026-09-26T05:00:00.000Z' },
  ]);
  assert.equal(ok.length, 1);
});

test('烘干仓容量按同时在仓量累计', async () => {
  const { service } = await makeService();
  await seed(service);
  await service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS }); // B1 已有 4 吨
  // 4 + 6 = 10,恰好满仓
  await service.reserve(dispatcher, [
    { kind: 'dry', equipmentId: 'DR1', binId: 'B1', load: 6, start: '2026-09-26T05:00:00.000Z', end: '2026-09-26T13:00:00.000Z' },
  ]);
  // 再叠加 1 吨即超容
  await assert.rejects(
    service.reserve(dispatcher, [
      { kind: 'dry', equipmentId: 'DR1', binId: 'B1', load: 1, start: '2026-09-26T06:00:00.000Z', end: '2026-09-26T12:00:00.000Z' },
    ]),
    /容量超限/
  );
});

test('降雨停工与设备停机期间不可排产,故障设备被隔离', async () => {
  const { service } = await makeService();
  await seed(service);
  await service.recordEvent(dispatcher, { type: 'rain_stop', at: '2026-09-26T00:00:00.000Z' });
  await assert.rejects(
    service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS }),
    /降雨停工/
  );
  await service.recordEvent(dispatcher, { type: 'rain_resume', at: '2026-09-26T00:30:00.000Z' });
  await service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS });

  await service.recordEvent(dispatcher, { type: 'equipment_down', equipmentId: 'H2', at: '2026-09-26T00:00:00.000Z', until: '2026-09-27T12:00:00.000Z' });
  assert.deepEqual(service.isolatedEquipment(), ['H2']);
  await assert.rejects(
    service.createJob(dispatcher, {
      id: 'J5',
      plotId: 'P1',
      steps: [
        { kind: 'harvest', equipmentId: 'H2', start: '2026-09-27T01:00:00.000Z', end: '2026-09-27T03:00:00.000Z' },
        { kind: 'store', destination: '中心粮库1号仓', start: '2026-09-27T03:00:00.000Z', end: '2026-09-27T04:00:00.000Z' },
      ],
    }),
    /停机/
  );
  await service.recordEvent(dispatcher, { type: 'equipment_up', equipmentId: 'H2', at: '2026-09-27T12:00:00.000Z' });
  assert.deepEqual(service.isolatedEquipment(), []);
});

test('临时改派只释放未开始的资源,已装载粮食必须到达明确去向', async () => {
  const { service } = await makeService();
  await seed(service);
  await service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS });
  await service.startStep(operator, 'J1', 0);
  await service.finishStep(operator, 'J1', 0); // 批次 B-J1 已产生
  await service.startStep(operator, 'J1', 1); // 粮食已装载上单轨

  // 去掉入库环节的改派被拒绝
  await assert.rejects(
    service.reassign(dispatcher, 'J1', [
      J1_STEPS[0],
      J1_STEPS[1],
      { kind: 'dry', equipmentId: 'DR1', binId: 'B2', load: 4, hours: 8, start: '2026-09-26T05:00:00.000Z', end: '2026-09-26T15:00:00.000Z' },
    ]),
    /明确去向/
  );

  // 合法改派:烘干换到 B2 仓
  const job = await service.reassign(dispatcher, 'J1', [
    J1_STEPS[0],
    J1_STEPS[1],
    { kind: 'dry', equipmentId: 'DR1', binId: 'B2', load: 4, hours: 8, start: '2026-09-26T05:00:00.000Z', end: '2026-09-26T15:00:00.000Z' },
    { kind: 'store', destination: '中心粮库2号仓', start: '2026-09-26T15:00:00.000Z', end: '2026-09-26T16:00:00.000Z' },
  ]);
  assert.equal(job.steps[2].binId, 'B2');
  // 已开始的环节预约保持原状,只有未开始的被释放
  assert.equal(service.state.reservations.get('J1#0').status, 'done');
  assert.equal(service.state.reservations.get('J1#1').status, 'active');
  assert.equal(service.state.reservations.get('J1#2').status, 'released');
  assert.equal(service.state.batches.get('B-J1').status, 'loaded');
});

test('角色权限:合作社只能确认自己,质检独立记录水分', async () => {
  const { service } = await makeService();
  await seed(service);
  await service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS });
  await service.startStep(operator, 'J1', 0);
  await service.finishStep(operator, 'J1', 0);

  await assert.rejects(service.confirmPlot(coopB, 'P1'), PermissionError);
  await service.confirmPlot(coopA, 'P1');
  assert.equal(service.state.plots.get('P1').confirmed, true);
  await assert.rejects(service.confirmBatch(coopB, 'B-J1'), PermissionError);
  await service.confirmBatch(coopA, 'B-J1');

  await assert.rejects(
    service.recordEvent(dispatcher, { type: 'quality_retest', batchId: 'B-J1', moisture: 14.1, at: '2026-09-26T15:00:00.000Z' }),
    PermissionError
  );
  await service.recordEvent(qc, { type: 'quality_retest', batchId: 'B-J1', moisture: 14.1, at: '2026-09-26T15:00:00.000Z' });
  assert.equal(service.storageCheck('B-J1').safe, false);

  await assert.rejects(
    service.createJob(coopA, { id: 'J9', plotId: 'P1', steps: J1_STEPS }),
    PermissionError
  );
});

test('进程重启后恢复到期作业、故障隔离与排队顺序', async () => {
  const { service, path } = await makeService();
  await seed(service);
  await service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS });
  await service.registerPlot(dispatcher, {
    id: 'P2',
    coopId: 'coop-b',
    maturity: '2026-09-26',
    slope: 12,
    expectedYield: 3,
    accessibleEquipment: ['H1'],
    deadline: '2026-09-29T00:00:00.000Z',
  });
  await service.createJob(dispatcher, {
    id: 'J2',
    plotId: 'P2',
    steps: [
      { kind: 'harvest', equipmentId: 'H1', start: '2026-09-26T05:00:00.000Z', end: '2026-09-26T07:00:00.000Z' },
      { kind: 'store', destination: '中心粮库2号仓', start: '2026-09-26T07:00:00.000Z', end: '2026-09-26T08:00:00.000Z' },
    ],
  });
  await service.recordEvent(dispatcher, { type: 'equipment_down', equipmentId: 'H2', at: '2026-09-26T00:00:00.000Z' });

  const reopened = await HarvestService.open(path);
  assert.equal(reopened.state.jobs.size, 2);
  assert.deepEqual(reopened.isolatedEquipment(), ['H2']);
  // H1 上的排队顺序保持预约先后
  assert.deepEqual(
    reopened.queueOf('H1').map((r) => r.jobId),
    ['J1', 'J2']
  );
  // 到期作业可继续执行
  await reopened.startStep(operator, 'J1', 0);
  await reopened.finishStep(operator, 'J1', 0);
  assert.equal(reopened.state.batches.get('B-J1').status, 'harvested');
});

test('调度查询:批次位置、下一台设备、延期影响与安全储存判定', async () => {
  const { service } = await makeService();
  await seed(service);
  await service.createJob(dispatcher, { id: 'J1', plotId: 'P1', steps: J1_STEPS });
  await service.registerPlot(dispatcher, {
    id: 'P3',
    coopId: 'coop-b',
    maturity: '2026-09-25',
    slope: 18,
    expectedYield: 2,
    accessibleEquipment: ['H2'],
    deadline: '2026-09-26T06:00:00.000Z',
  });
  await service.createJob(dispatcher, {
    id: 'J3',
    plotId: 'P3',
    steps: [
      { kind: 'harvest', equipmentId: 'H2', start: '2026-09-26T01:00:00.000Z', end: '2026-09-26T03:00:00.000Z' },
      { kind: 'dry', equipmentId: 'DR1', binId: 'B2', load: 2, hours: 6, start: '2026-09-26T04:00:00.000Z', end: '2026-09-26T12:00:00.000Z' },
      { kind: 'store', destination: '中心粮库3号仓', start: '2026-09-26T12:00:00.000Z', end: '2026-09-26T13:00:00.000Z' },
    ],
  });

  await service.startStep(operator, 'J1', 0);
  await service.finishStep(operator, 'J1', 0);
  await service.recordEvent(operator, { type: 'weighed', batchId: 'B-J1', weight: 4.2, at: '2026-09-26T03:10:00.000Z' });
  let status = service.batchStatus('B-J1');
  assert.equal(status.weight, 4.2);
  assert.deepEqual(status.location, { kind: 'harvest', equipmentId: 'H1', destination: null });
  assert.deepEqual(status.next, { kind: 'transport', equipmentId: 'M1', destination: null });

  await service.startStep(operator, 'J1', 1);
  await service.finishStep(operator, 'J1', 1);
  await service.startStep(operator, 'J1', 2);
  status = service.batchStatus('B-J1');
  assert.equal(status.location.kind, 'dry');
  assert.equal(status.next.kind, 'store');
  assert.equal(status.next.destination, '中心粮库1号仓');

  // J3 预计 13:00 结束,超过 P3 的 06:00 截止
  assert.deepEqual(
    service.delayImpact().map((d) => d.plotId),
    ['P3']
  );
  assert.deepEqual(
    service.equipmentImpact('DR1').map((d) => d.jobId).sort(),
    ['J1', 'J3']
  );

  await service.finishStep(operator, 'J1', 2);
  await service.recordEvent(qc, { type: 'quality_retest', batchId: 'B-J1', moisture: 14.2, at: '2026-09-26T14:30:00.000Z' });
  assert.equal(service.storageCheck('B-J1').safe, false);
  await service.recordEvent(qc, { type: 'quality_retest', batchId: 'B-J1', moisture: 13.2, at: '2026-09-26T15:00:00.000Z' });
  const check = service.storageCheck('B-J1');
  assert.equal(check.safe, true);
  assert.equal(check.moisture, 13.2);

  await service.startStep(operator, 'J1', 3);
  await service.finishStep(operator, 'J1', 3);
  assert.equal(service.batchStatus('B-J1').status, 'stored');
  assert.deepEqual(service.delayImpact().map((d) => d.plotId), ['P3']);
});

test('跨村调机按事件顺序更新设备归属', async () => {
  const { service } = await makeService();
  await seed(service);
  await service.recordEvent(dispatcher, { type: 'cross_village_dispatch', equipmentId: 'H1', fromVillage: '上村', toVillage: '下村', at: '2026-09-26T08:00:00.000Z' });
  assert.equal(service.state.equipment.get('H1').village, '下村');
});
