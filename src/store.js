import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { applyEvent, replay } from './state.js';

// JSONL 事务日志：每个事务恰好一行。
// 写入不是整行（进程崩溃、断电）→ 重启时该行连同之后内容一并丢弃，事务不留下半份。
export class EventStore {
  constructor(path) {
    this.path = path;
    const loaded = existsSync(path) ? loadTransactions(path) : { txs: [], committedBytes: 0 };
    this.txs = loaded.txs;
    this.committedBytes = loaded.committedBytes;
    // 打开时物理丢弃残行（上次崩溃未提交的半个事务），保证后续追加落在干净的行尾。
    if (existsSync(path)) {
      const raw = readFileSync(path);
      if (raw.length !== this.committedBytes) writeFileSync(path, raw.subarray(0, this.committedBytes));
    }
    this.state = replay(this.txs.flatMap((tx) => tx.events));
    for (const tx of this.txs) this.state.txIds.add(tx.txId);
  }

  // 一个事务内的事件要么全部可见，要么全部不可见。
  commit(txId, at, events) {
    if (this.state.txIds.has(txId)) throw new Error(`事务编号重复：${txId}`);
    const record = JSON.stringify({ txId, at, events }) + '\n';
    const before = this.committedBytes;
    appendFileSync(this.path, record);
    // 重新按字节读取校验：整行落盘才算提交成功。
    const loaded = loadTransactions(this.path);
    if (loaded.committedBytes < before + Buffer.byteLength(record)) {
      throw new Error('事务落盘不完整，视为未提交');
    }
    this.txs = loaded.txs;
    this.committedBytes = loaded.committedBytes;
    for (const event of events) applyEvent(this.state, event);
    this.state.txIds.add(txId);
    return this.state;
  }

  // 故障注入：把底层文件末尾截掉若干字节，制造残行，模拟提交途中崩溃。
  truncateTail(dropBytes) {
    const raw = readFileSync(this.path);
    writeFileSync(this.path, raw.subarray(0, Math.max(0, raw.length - dropBytes)));
  }
}

function loadTransactions(path) {
  const raw = readFileSync(path);
  const text = raw.toString('utf8');
  let offset = 0;
  const txs = [];
  for (const line of text.split('\n')) {
    const byteLen = Buffer.byteLength(line) + 1; // 含换行符
    if (line.length === 0) {
      offset += byteLen;
      continue;
    }
    let tx;
    try {
      tx = JSON.parse(line);
    } catch {
      // 残行：截断到此为止，之后内容都属于未提交数据。
      return { txs, committedBytes: offset };
    }
    if (!tx || !Array.isArray(tx.events)) {
      return { txs, committedBytes: offset };
    }
    txs.push(tx);
    offset += byteLen;
  }
  return { txs, committedBytes: raw.length };
}
