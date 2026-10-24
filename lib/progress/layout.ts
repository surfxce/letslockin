/**
 * Positions for the lecture map: a force layout (linked lectures pull together,
 * every pair pushes apart), deterministic so the map looks the same each visit.
 * Coordinates are in a 1000 × 640 box.
 */
export const MAP_W = 1000;
export const MAP_H = 640;

export function layoutMap(
  nodes: Array<{ id: string; group: string }>,
  links: Array<{ a: string; b: string; score: number }>,
  iterations = 400,
): Map<string, { x: number; y: number }> {
  const n = nodes.length;
  const pos = new Map<string, { x: number; y: number }>();
  if (!n) return pos;
  // Start on a circle, each course's lectures together, in lecture order.
  const groups = [...new Set(nodes.map((d) => d.group))];
  const ordered = groups.flatMap((g) => nodes.filter((d) => d.group === g));
  ordered.forEach((d, i) => {
    const a = (2 * Math.PI * i) / n;
    pos.set(d.id, { x: MAP_W / 2 + Math.cos(a) * MAP_W * 0.35, y: MAP_H / 2 + Math.sin(a) * MAP_H * 0.35 });
  });
  if (n === 1) {
    pos.set(nodes[0].id, { x: MAP_W / 2, y: MAP_H / 2 });
    return pos;
  }
  const k = Math.sqrt((MAP_W * MAP_H) / n) * 0.75;
  const ids = ordered.map((d) => d.id);
  const groupOf = new Map(nodes.map((d) => [d.id, d.group]));
  for (let it = 0; it < iterations; it++) {
    const temp = (MAP_W / 10) * (1 - it / iterations) + 1;
    const move = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const p = pos.get(ids[i])!;
        const q = pos.get(ids[j])!;
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) {
          dx = (i - j) * 0.01;
          dy = 0.01;
          d = Math.hypot(dx, dy);
        }
        // Lectures of other courses keep a little further apart.
        const f = ((k * k) / d) * (groupOf.get(ids[i]) === groupOf.get(ids[j]) ? 1 : 1.6);
        move.get(ids[i])!.x += (dx / d) * f;
        move.get(ids[i])!.y += (dy / d) * f;
        move.get(ids[j])!.x -= (dx / d) * f;
        move.get(ids[j])!.y -= (dy / d) * f;
      }
    }
    for (const l of links) {
      const p = pos.get(l.a);
      const q = pos.get(l.b);
      if (!p || !q) continue;
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = ((d * d) / k) * (0.5 + l.score * 2);
      move.get(l.a)!.x -= (dx / d) * f;
      move.get(l.a)!.y -= (dy / d) * f;
      move.get(l.b)!.x += (dx / d) * f;
      move.get(l.b)!.y += (dy / d) * f;
    }
    for (const id of ids) {
      const m = move.get(id)!;
      const p = pos.get(id)!;
      // A pull to the middle stops loners drifting off the map.
      m.x += (MAP_W / 2 - p.x) * 0.02 * k;
      m.y += (MAP_H / 2 - p.y) * 0.02 * k;
      const d = Math.hypot(m.x, m.y) || 1;
      p.x += (m.x / d) * Math.min(d, temp);
      p.y += (m.y / d) * Math.min(d, temp);
    }
  }
  // Fit the result to the box, with room for labels.
  const xs = ids.map((id) => pos.get(id)!.x);
  const ys = ids.map((id) => pos.get(id)!.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = { x: 110, y: 40 };
  const sx = (MAP_W - 2 * pad.x) / Math.max(1, maxX - minX);
  const sy = (MAP_H - 2 * pad.y) / Math.max(1, maxY - minY);
  for (const id of ids) {
    const p = pos.get(id)!;
    pos.set(id, { x: pad.x + (p.x - minX) * sx, y: pad.y + (p.y - minY) * sy });
  }
  return pos;
}
