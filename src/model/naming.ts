/** "Shelf" / "Shelf 2" → next free "Shelf N" given existing names. */
export function copyName(name: string, existing: Iterable<string>): string {
  const stem = name.replace(/\s+\d+$/, '') || name;
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: (\\d+))?$`, 'i');
  let max = 1;
  for (const n of existing) {
    const m = re.exec(n);
    if (m) max = Math.max(max, m[1] ? parseInt(m[1], 10) : 1);
  }
  return `${stem} ${max + 1}`;
}
