// 读取并检查仓库中的领域资料。
export function parseDomain(raw) {
  const value = JSON.parse(raw);
  const keys = ['actors', 'constraints', 'domain', 'facts', 'sample_id', 'version'];
  if (Object.keys(value).sort().join(',') !== keys.join(',') || value.version < 1 || value.actors.length < 2 || value.facts.length < 2 || value.constraints.length < 3) {
    throw new Error('领域资料内容不完整');
  }
  return value;
}
