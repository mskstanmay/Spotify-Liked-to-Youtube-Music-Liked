function renderProgress(current, total) {
  if (!total) return '[--------------------] 0%  0/0';
  const width = 20;
  const pct = current / total;
  const filled = Math.round(width * pct);
  const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
  return `[${bar}] ${Math.round(pct * 100)}%  ${current}/${total}`;
}

module.exports = { renderProgress };
