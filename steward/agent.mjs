// Steward agent for the agent test bed. Runs once a day on its own.
// It reads the whole city, finds what is missing between chunks, writes the steward's daily turn,
// dry runs it, drops anything the engine would refuse, then signs and submits it.
// Usage: AGENT_KEY=stewardkey node agent.mjs /path/to/testbed/clone [--dry]
import fs from 'fs';
import path from 'path';
import {execFileSync} from 'child_process';

const repo = path.resolve(process.argv[2] || '.');
const dry = process.argv.includes('--dry');
const ID = 'steward';
const date = new Date().toISOString().slice(0, 10);
const rel = 'contrib/' + ID + '/' + date + '.json';
const {replay} = await import(path.join(repo, 'engine.js'));
const {loadContrib, loadConfig} = await import(path.join(repo, 'scripts/load.mjs'));

const C = 79248, PORT = 5486, LINE = PORT + 900;
let kept = [];
try { const j = JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8')); kept = (Array.isArray(j) ? j : j.calls) || []; } catch (e) {}
const {files} = loadContrib(repo);
const W = replay(files, null, loadConfig(repo));
const recs = [];
for (const c of W.chunks.values()) for (const r of c.records) if (!r.hidden) recs.push(Object.assign({cx: c.cx, cy: c.cy}, r));
const owned = new Set([...W.chunks.values()].filter(c => c.owner).map(c => c.cx + ',' + c.cy));
const has = (cx, cy) => owned.has(cx + ',' + cy);
const calls = [], log = [];

// street names come from the builders' own street records on each chunk edge
const nsName = {}, ewName = {};
for (const r of recs) if (r.discipline === 'street' && r.kind === 'line' && r.meta && typeof r.meta.street === 'string' && r.pts.length >= 2) {
  const p = r.pts[0], q = r.pts[r.pts.length - 1];
  if (Math.abs(p[0] - q[0]) < 5 && Math.abs(p[0] - Math.round(p[0] / C) * C) < PORT) nsName[Math.round(p[0] / C)] ??= r.meta.street;
  if (Math.abs(p[1] - q[1]) < 5 && Math.abs(p[1] - Math.round(p[1] / C) * C) < PORT) ewName[Math.round(p[1] / C)] ??= r.meta.street;
}

// ---------- crosswalks: complete every half crosswalk whose street half exists ----------
const cws = recs.filter(r => r.kind === 'hatch' && r.meta && /crosswalk/.test(r.meta.part || ''));
const bbox = r => { const xs = r.pts.map(p => p[0]), ys = r.pts.map(p => p[1]); return {x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys)}; };
function findHalf(X, Y, along, sgn, half) {
  return cws.find(c => { const b = bbox(c), mx = (b.x0 + b.x1) / 2 - X, my = (b.y0 + b.y1) / 2 - Y;
    if (along === 'x') return Math.sign(mx) === sgn && Math.abs(mx) < 12000 && (half > 0 ? my > 0 : my < 0) && Math.abs(my) < PORT && (b.y1 - b.y0) > (b.x1 - b.x0);
    return Math.sign(my) === sgn && Math.abs(my) < 12000 && (half > 0 ? mx > 0 : mx < 0) && Math.abs(mx) < PORT && (b.x1 - b.x0) > (b.y1 - b.y0); });
}
const corners = new Set();
for (const k of owned) { const [cx, cy] = k.split(',').map(Number); for (const dx of [0, 1]) for (const dy of [0, 1]) corners.add((cx + dx) + ',' + (cy + dy)); }
for (const k of [...corners].sort()) {
  const [i, j] = k.split(',').map(Number), X = i * C, Y = j * C;
  const legs = [
    {along: 'x', sgn: 1, halves: [[1, [i, j]], [-1, [i, j - 1]]]}, {along: 'x', sgn: -1, halves: [[1, [i - 1, j]], [-1, [i - 1, j - 1]]]},
    {along: 'y', sgn: 1, halves: [[1, [i, j]], [-1, [i - 1, j]]]}, {along: 'y', sgn: -1, halves: [[1, [i, j - 1]], [-1, [i - 1, j - 1]]]}];
  for (const leg of legs) for (const [h, ch] of leg.halves) {
    if (!has(...ch) || findHalf(X, Y, leg.along, leg.sgn, h)) continue;
    const partner = findHalf(X, Y, leg.along, leg.sgn, -h);
    let pts, color = 7, pattern = 'lines', spacing = 610, angle, meta;
    if (partner) {
      pts = partner.pts.map(p => leg.along === 'x' ? [p[0], 2 * Y - p[1], p[2]] : [2 * X - p[0], p[1], p[2]]);
      color = partner.color; pattern = partner.pattern; spacing = partner.spacing; angle = partner.angle; meta = Object.assign({}, partner.meta);
    } else if (leg.along === 'x') {
      const a = X + leg.sgn * 1200, b = X + leg.sgn * 4200, y0 = h > 0 ? Y : Y - PORT, y1 = h > 0 ? Y + PORT : Y;
      pts = [[Math.min(a, b), y0, 0], [Math.max(a, b), y0, 0], [Math.max(a, b), y1, 0], [Math.min(a, b), y1, 0]]; angle = 0; meta = {street: nsName[i] || ewName[j] || 'crosswalk', part: 'crosswalk'};
    } else {
      const a = Y + leg.sgn * 1200, b = Y + leg.sgn * 4200, x0 = h > 0 ? X : X - PORT, x1 = h > 0 ? X + PORT : X;
      pts = [[x0, Math.min(a, b), 0], [x1, Math.min(a, b), 0], [x1, Math.max(a, b), 0], [x0, Math.max(a, b), 0]]; angle = 90; meta = {street: ewName[j] || nsName[i] || 'crosswalk', part: 'crosswalk'};
    }
    const inside = p => p[0] >= ch[0] * C && p[0] <= (ch[0] + 1) * C && p[1] >= ch[1] * C && p[1] <= (ch[1] + 1) * C;
    for (let n = 0; n < 4 && !inside(pts[0]); n++) pts.push(pts.shift());
    meta.steward = 'completes the crosswalk across the street';
    calls.push({tool: 'place_hatch', args: {discipline: 'street', color, pts, pattern, spacing, angle, meta}});
    log.push('crosswalk half at corner ' + k + (partner ? ' matching ' + partner.agent : ''));
  }
}

// ---------- pole lines with power, telephone and cable wires across chunk borders ----------
const dSeg = (p, a, b) => { const vx = b[0] - a[0], vy = b[1] - a[1], L = vx * vx + vy * vy; let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(a[0] + t * vx - p[0], a[1] + t * vy - p[1]); };
const inPoly = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
function blocker(p) {
  for (const r of recs) {
    if (r.kind === 'symbol') {
      const lim = ['tree', 'sign', 'hydrant', 'light', 'pole', 'bench', 'table', 'umbrella', 'cart'].includes(r.type) ? 1500 : 1000;
      if (r.at[2] < 3000 && Math.hypot(r.at[0] - p[0], r.at[1] - p[1]) < lim) return r.type;
      const an = r.meta && r.meta.anim;
      if (an && an.type === 'path' && Array.isArray(an.pts)) for (let i = 1; i < an.pts.length; i++) if (dSeg(p, an.pts[i - 1], an.pts[i]) < 700) return 'path of ' + r.type;
    } else if (r.kind === 'hatch') {
      if (/sidewalk/i.test(JSON.stringify(r.meta || {}))) continue;
      if (r.pts.every(q => q[2] < 600) && inPoly(p, r.pts)) return 'hatch';
    } else for (let i = 1; i < r.pts.length; i++) { const a = r.pts[i - 1], b = r.pts[i]; if (Math.min(a[2], b[2]) <= 3000 && dSeg(p, a, b) < 450) return 'line'; }
  }
  return null;
}
const poles = () => recs.filter(r => r.kind === 'symbol' && r.type === 'pole' && !/flag/i.test((r.meta && r.meta.part) || ''));
const wireKey = (a, b) => [a, b].map(p => Math.round(p[0] / 300) + ',' + Math.round(p[1] / 300) + ',' + Math.round(p[2] / 300)).sort().join('|');
const wiresHave = new Set(recs.filter(r => r.discipline === 'electrical' && r.kind === 'line' && r.pts.length > 1).map(r => wireKey(r.pts[0], r.pts[r.pts.length - 1])));
const sag = (a, b, s, n = 6) => { const o = []; for (let t = 0; t <= n; t++) { const u = t / n; o.push([Math.round(a[0] + (b[0] - a[0]) * u), Math.round(a[1] + (b[1] - a[1]) * u), Math.round(a[2] + (b[2] - a[2]) * u - s * 4 * u * (1 - u))]); } return o; };
function wire(a, b, s, color, part, street) {
  if (wiresHave.has(wireKey(a, b))) return 0;
  wiresHave.add(wireKey(a, b));
  calls.push({tool: 'place_line', args: {discipline: 'electrical', color, pts: sag(a, b, s), meta: {part, street}}});
  return 1;
}
const streetLit = (cx, cy) => recs.some(r => r.type === 'light' && r.meta && /street light/.test(r.meta.part || '') && Math.floor(r.at[0] / C) === cx && Math.floor(r.at[1] / C) === cy);
const litNow = new Set();
let built = 0;
// one pole line per north south street, on the side of the street with more claimed blocks
const xs = new Set(); for (const k of owned) { const cx = +k.split(',')[0]; xs.add(cx); xs.add(cx + 1); }
const lineXs = [];
for (const i of [...xs].sort((a, b) => a - b)) {
  const east = [...owned].filter(k => +k.split(',')[0] === i).map(k => +k.split(',')[1]);
  const west = [...owned].filter(k => +k.split(',')[0] === i - 1).map(k => +k.split(',')[1]);
  const exist = poles().filter(p => Math.abs(p.at[0] - i * C) < 12000);
  const eScore = east.length + exist.filter(p => p.at[0] > i * C).length * 0.5, wScore = west.length + exist.filter(p => p.at[0] < i * C).length * 0.5;
  const side = eScore >= wScore ? 1 : -1, ks = side > 0 ? east : west;
  if (!ks.length) continue;
  const x = i * C + side * LINE, name = nsName[i] || 'Avenue ' + i;
  lineXs.push(x);
  const ky0 = Math.min(...ks), ky1 = Math.max(...ks);
  const route = [];
  for (let k = ky0; k <= ky1; k++) {
    if (!ks.includes(k)) continue;
    const y0 = k * C + 11500, y1 = (k + 1) * C - 11500;
    const anchors = poles().filter(p => Math.abs(p.at[0] - x) < 2600 && p.at[1] >= y0 - 2000 && p.at[1] <= y1 + 2000).map(p => ({x: p.at[0], y: p.at[1], own: false}));
    let pts = [{x, y: y0, own: true}, ...anchors, {x, y: y1, own: true}].sort((a, b) => a.y - b.y);
    pts = pts.filter(q => !(q.own && pts.some(o => !o.own && Math.abs(o.y - q.y) < 9000)));
    const full = [pts[0]];
    for (let n = 1; n < pts.length; n++) { const a = full[full.length - 1], b = pts[n], gap = b.y - a.y, m = Math.ceil(gap / 30000);
      for (let s = 1; s < m; s++) full.push({x, y: Math.round(a.y + gap * s / m), own: true}); full.push(b); }
    full.forEach((q, n) => { q.blockEnd = n === 0 || n === full.length - 1; });
    route.push(...full);
  }
  const live = [];
  for (const q of route) {
    if (q.own) {
      let ok = null;
      for (const d of [0, 600, -600, 1200, -1200, 1800, -1800, 2400, -2400, 3000, -3000, 3600, -3600]) if (!blocker([q.x, q.y + d, 0])) { ok = d; break; }
      if (ok === null) { log.push(name + ': no clear spot for a pole near y ' + q.y); continue; }
      q.y = Math.round(q.y + ok);
      calls.push({tool: 'place_symbol', args: {discipline: 'electrical', color: 9, type: 'pole', at: [q.x, q.y, 0], rot: 0, meta: {part: 'wood utility pole, ' + name + ' pole line', street: name}}});
      recs.push({kind: 'symbol', type: 'pole', at: [q.x, q.y, 0], meta: {}});
      built++;
    }
    live.push(q);
    const cx = Math.floor(q.x / C), cy = Math.floor(q.y / C), lk = cx + ',' + cy + ',' + q.y;
    if (q.own && q.blockEnd && !streetLit(cx, cy) && !litNow.has(lk)) {
      const side2 = -side, ax = q.x + side2 * 2400;
      calls.push({tool: 'place_line', args: {discipline: 'street', color: 7, pts: [[q.x, q.y, 7300], [q.x + side2 * 1200, q.y, 7650], [ax, q.y, 7700]], meta: {street: name, part: 'street light mast arm'}}});
      calls.push({tool: 'place_symbol', args: {discipline: 'street', color: 11, type: 'light', at: [ax + side2 * 250, q.y, 7600], rot: 0, meta: {street: name, part: 'cobra head street light'}}});
      litNow.add(lk);
    }
  }
  for (let n = 1; n < live.length; n++) {
    const A = live[n - 1], B = live[n], span = Math.hypot(B.x - A.x, B.y - A.y);
    if (span > 45000) continue;
    const s = Math.min(600, Math.round(span / 80));
    const over = Math.floor(A.y / C) !== Math.floor(B.y / C) ? ', span over ' + (ewName[Math.round(Math.max(A.y, B.y) / C)] || 'the cross street') : '';
    const tag = name + ' pole line' + over;
    for (const dx of [-900, 900]) built += wire([A.x + dx, A.y, 8230], [B.x + dx, B.y, 8230], s, 1, 'primary conductor, ' + tag, name);
    built += wire([A.x, A.y, 6100], [B.x, B.y, 6100], s + 150, 7, 'telephone cable, ' + tag, name);
    built += wire([A.x, A.y, 5600], [B.x, B.y, 5600], s + 250, 5, 'cable tv and fiber line, ' + tag, name);
  }
  log.push(name + ' pole line: ' + live.length + ' poles');
}
// builder poles standing off every pole line get a single phase tap and a telephone drop from the nearest line pole
const linePoles = poles().filter(p => lineXs.some(x => Math.abs(p.at[0] - x) < 2600));
for (const T of poles()) {
  if (lineXs.some(x => Math.abs(T.at[0] - x) < 2600)) continue;
  let best = null, bd = 1e12;
  for (const L of linePoles) { const d = Math.hypot(L.at[0] - T.at[0], L.at[1] - T.at[1]); if (d < bd) { bd = d; best = L; } }
  if (!best || bd > 30000) continue;
  const dir = Math.sign(T.at[0] - best.at[0]) || 1, name = (T.meta && T.meta.street) || 'the street';
  built += wire([best.at[0] + dir * 900, best.at[1], 8230], [T.at[0] - dir * 900, T.at[1], 8230], 250, 1, 'single phase tap to a builder pole', name);
  built += wire([best.at[0], best.at[1], 6100], [T.at[0], T.at[1], 6100], 400, 7, 'telephone drop to a builder pole', name);
}

if (!calls.length) { console.log('Steward: nothing missing between chunks today.'); process.exit(0); }
fs.mkdirSync(path.join(repo, 'contrib', ID), {recursive: true});
const ap = path.join(repo, 'contrib', ID, 'agent.json');
if (!fs.existsSync(ap)) fs.writeFileSync(ap, JSON.stringify({name: 'Steward', model: 'Claude Opus 5.5', about: 'Ties the city together between chunks: pole lines, telephone and power wires, crosswalks, street lights and matching street joins.', color: 11}, null, 1) + '\n');
const write = c => fs.writeFileSync(path.join(repo, rel), JSON.stringify({calls: kept.concat(c)}, null, 1) + '\n');
write(calls);
// dry run with the game's own checker and drop anything it would refuse
const res = JSON.parse(execFileSync('node', ['scripts/check.mjs', rel], {cwd: repo}).toString());
let final = calls;
if (res.rejected.length) { const bad = new Set(res.rejected.map(r => r.index - kept.length)); final = calls.filter((c, n) => !bad.has(n)); write(final); log.push('dropped ' + bad.size + ' refused calls'); }
console.log(log.join('\n'));
console.log('Steward turn ' + date + ': ' + final.length + ' calls.');
if (dry) process.exit(0);
if (!process.env.AGENT_KEY) { console.log('No AGENT_KEY, not submitting.'); process.exit(1); }
execFileSync('node', ['scripts/submit.mjs', rel], {cwd: repo, stdio: 'inherit', env: process.env});
