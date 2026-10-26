// Detailer agent for the agent test bed. Runs once a day on its own.
// It walks every record in the city looking for things that move or sit wrong, hides the broken record
// with a reason, places a corrected one where a correction is clear, then dry runs, signs and submits.
// Usage: AGENT_KEY=detailerkey node agent.mjs /path/to/testbed/clone [--dry]
import fs from 'fs';
import path from 'path';
import {execFileSync} from 'child_process';

const repo = path.resolve(process.argv[2] || '.');
const dry = process.argv.includes('--dry');
const ID = 'detailer';
const date = new Date().toISOString().slice(0, 10);
const turn = new Date().toISOString().replace(/[-:]/g, '').replace(/^(\d{4})(\d{2})(\d{2})T(\d{6}).*$/, '$1-$2-$3T$4');
const rel = 'contrib/' + ID + '/' + turn + '.json';
const fileAbs = path.join(repo, rel);
const {replay} = await import(path.join(repo, 'engine.js'));
const {loadContrib, loadConfig} = await import(path.join(repo, 'scripts/load.mjs'));

// every turn is its own new file
const kept = [];
const {files} = loadContrib(repo);
const W = replay(files, null, loadConfig(repo));
const C = 79248, PORT = 5486;
const recs = [];
for (const c of W.chunks.values()) for (const r of c.records) if (!r.hidden) recs.push(Object.assign({cx: c.cx, cy: c.cy}, r));
const calls = [], log = [], done = new Set();
const hide = (r, reason) => { if (done.has(r.id)) return false; done.add(r.id); calls.push({tool: 'steward_hide', args: {id: r.id, reason}}); log.push(r.id + ' ' + r.agent + ': ' + reason); return true; };
const replaceSymbol = (r, changes) => {
  const args = {discipline: r.discipline, color: r.color, type: r.type, at: r.at.slice(), rot: r.rot || 0, meta: Object.assign({}, r.meta || {})};
  Object.assign(args, changes.top || {}); Object.assign(args.meta, changes.meta || {});
  for (const k of changes.dropMeta || []) delete args.meta[k];
  calls.push({tool: 'place_symbol', args});
};

// building footprints from named wall lines, shrunk a little so things against the wall do not count
const bld = new Map();
for (const r of recs) if (r.kind === 'line' && r.meta && r.meta.wall && typeof r.meta.building === 'string') {
  const b = bld.get(r.meta.building) || {x0: 1e12, y0: 1e12, x1: -1e12, y1: -1e12, h: 0, zmin: 0};
  for (const p of r.pts) { b.x0 = Math.min(b.x0, p[0]); b.y0 = Math.min(b.y0, p[1]); b.x1 = Math.max(b.x1, p[0]); b.y1 = Math.max(b.y1, p[1]); }
  b.h = Math.max(b.h, r.meta.h || 3048); bld.set(r.meta.building, b);
}
const boxes = [...bld.entries()].filter(([, b]) => b.x1 - b.x0 > 2000 && b.y1 - b.y0 > 2000).map(([n, b]) => ({n, x0: b.x0 + 400, y0: b.y0 + 400, x1: b.x1 - 400, y1: b.y1 - 400}));
const inBox = p => boxes.find(b => p[0] > b.x0 && p[0] < b.x1 && p[1] > b.y0 && p[1] < b.y1);
const segHitsBox = (a, b) => { for (let t = 0; t <= 20; t++) { const u = t / 20, hit = inBox([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); if (hit) return hit; } return null; };

for (const r of recs) {
  if (r.kind !== 'symbol') continue;
  const m = r.meta || {}, an = m.anim, moving = an && an.type === 'path' && Array.isArray(an.pts) && an.pts.length > 1;
  // a bike that moves has nobody on it
  if (r.type === 'bike' && moving) { if (hide(r, 'bike moved with no rider')) replaceSymbol(r, {top: {type: 'cyclist'}}); continue; }
  // a person moving along a path should be walking
  if (r.type === 'person' && moving && m.pose !== 'walking') { if (hide(r, 'person slid along a path while ' + (m.pose || 'standing'))) replaceSymbol(r, {meta: {pose: 'walking'}}); continue; }
  // vehicles that drive through a building
  if (moving && ['car', 'truck', 'cart', 'cyclist', 'bike'].includes(r.type)) {
    let hit = null; for (let i = 1; i < an.pts.length && !hit; i++) if (Math.min(an.pts[i - 1][2], an.pts[i][2]) < 2500) hit = segHitsBox(an.pts[i - 1], an.pts[i]);
    if (hit) { hide(r, r.type + ' drove through ' + hit.n); continue; }
    // right hand traffic: a vehicle running along one street on the wrong side gets mirrored to the correct lane
    if (r.type === 'car' || r.type === 'truck') {
      let wrong = 0, right = 0, axis = null, line = null;
      for (let i = 1; i < an.pts.length; i++) {
        const a = an.pts[i - 1], b = an.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        if (Math.abs(dx) > 4 * Math.abs(dy)) { const Y = Math.round(my / C) * C; if (Math.abs(my - Y) < PORT) { const ok = dx > 0 ? my < Y : my > Y; ok ? right++ : wrong++; axis = axis === null || axis === 'y:' + Y ? 'y:' + Y : 'mixed'; line = Y; } }
        else if (Math.abs(dy) > 4 * Math.abs(dx)) { const X = Math.round(mx / C) * C; if (Math.abs(mx - X) < PORT) { const ok = dy > 0 ? mx > X : mx < X; ok ? right++ : wrong++; axis = axis === null || axis === 'x:' + X ? 'x:' + X : 'mixed'; line = X; } }
      }
      if (wrong && !right && axis && axis !== 'mixed') {
        const flip = p => axis[0] === 'y' ? [p[0], 2 * line - p[1], p[2]] : [2 * line - p[0], p[1], p[2]];
        if (hide(r, r.type + ' drove in the oncoming lane')) replaceSymbol(r, {top: {at: flip(r.at)}, meta: {anim: Object.assign({}, an, {pts: an.pts.map(flip)})}});
        continue;
      }
    }
  }
  // things that belong outdoors standing inside a building
  if (!moving && ['tree', 'hydrant', 'pole'].includes(r.type) && r.at[2] < 500) { const b = inBox(r.at); if (b) { hide(r, r.type + ' stood inside ' + b.n); continue; } }
}
// exact duplicates stacked on each other
const seen = new Map();
for (const r of recs) {
  const k = r.kind === 'symbol' ? r.agent + '|' + r.type + '|' + r.at.map(v => Math.round(v / 100)).join(',') + '|' + JSON.stringify((r.meta || {}).anim || '') : r.agent + '|' + r.kind + '|' + r.discipline + '|' + JSON.stringify(r.pts);
  if (seen.has(k)) hide(r, 'exact duplicate of record ' + seen.get(k) + ' drawn on top of it'); else seen.set(k, r.id);
}

if (!calls.length) { console.log('Detailer: nothing broken today.'); process.exit(0); }
fs.mkdirSync(path.dirname(fileAbs), {recursive: true});
const write = c => fs.writeFileSync(fileAbs, JSON.stringify({calls: kept.concat(c)}, null, 1) + '\n');
write(calls);
const res = JSON.parse(execFileSync('node', ['scripts/check.mjs', rel], {cwd: repo}).toString());
let final = calls;
if (res.rejected.length) { const bad = new Set(res.rejected.map(x => x.index - kept.length)); final = calls.filter((c, n) => !bad.has(n)); write(final); log.push('dropped ' + bad.size + ' refused calls'); }
console.log(log.join('\n'));
console.log('Detailer turn ' + turn + ': ' + final.length + ' new calls.');
if (dry) process.exit(0);
if (!process.env.AGENT_KEY) { console.log('No AGENT_KEY, not submitting.'); process.exit(1); }
execFileSync('node', ['scripts/submit.mjs', rel], {cwd: repo, stdio: 'inherit', env: process.env});
