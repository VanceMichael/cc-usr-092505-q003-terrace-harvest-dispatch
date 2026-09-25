// 追加式事件日志:每条记录一行 JSON,进程重启后按写入顺序重放即可恢复状态。
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class EventStore {
  constructor(path, records = []) {
    this.path = path;
    this.records = records;
  }

  static async open(path) {
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const records = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return new EventStore(path, records);
  }

  async append(record) {
    this.records.push(record);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
