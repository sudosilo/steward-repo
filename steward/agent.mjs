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

// ---------- water and sewer mains under every street, stitched to the builders' mains and services ----------
{
  const plumb = recs.filter(r => r.discipline === 'plumbing' && r.kind === 'line' && r.pts.length >= 2);
  const kindOf = r => { const p = String((r.meta && r.meta.part) || ''); if (/fuel|gas|drip|irrigation|orchard|septic|well|drop pipe|vent/i.test(p)) return null; if (/sewer|waste|lateral|outfall|drain/i.test(p)) return 'sewer'; if (/water/i.test(p)) return 'water'; return null; };
  const isMain = r => /\bmain\b/i.test(String((r.meta && r.meta.part) || '')) && !/tap|header|to every|branch/i.test(String(r.meta.part));
  const STD = {water: {off: 2400, z: -1219}, sewer: {off: 3600, z: -2134}};
  // every street edge line beside a claimed block: {axis:'y', at:Y, from, to} runs east west, axis 'x' runs north south
  const edges = new Map();
  for (const k of owned) { const [cx, cy] = k.split(',').map(Number);
    for (const e of [{axis: 'y', at: cy * C, from: cx * C}, {axis: 'y', at: (cy + 1) * C, from: cx * C}, {axis: 'x', at: cx * C, from: cy * C}, {axis: 'x', at: (cx + 1) * C, from: cy * C}])
      edges.set(e.axis + e.at + ':' + e.from, Object.assign(e, {to: e.from + C})); }
  const along = (p, axis) => axis === 'y' ? p[0] : p[1], across = (p, axis) => axis === 'y' ? p[1] : p[0];
  const P = (axis, a, o, z) => axis === 'y' ? [Math.round(a), Math.round(o), z] : [Math.round(o), Math.round(a), z];
  const mainsOn = (axis, at, kind) => plumb.filter(r => isMain(r) && kindOf(r) === kind).map(r => {
    const a = r.pts[0], b = r.pts[r.pts.length - 1];
    if (Math.abs(across(a, axis) - across(b, axis)) > 50 || Math.abs(across(a, axis) - at) > PORT) return null;
    return {a: Math.min(along(a, axis), along(b, axis)), b: Math.max(along(a, axis), along(b, axis)), off: across(a, axis) - at, z: a[2]};
  }).filter(Boolean);
  const lineDefault = {};
  const defaultFor = (axis, at, kind) => { const key = axis + at + kind; if (lineDefault[key]) return lineDefault[key];
    const m = mainsOn(axis, at, kind).sort((p, q) => (q.b - q.a) - (p.b - p.a))[0];
    return (lineDefault[key] = m ? {off: m.off, z: m.z} : STD[kind]); };
  const nameOf = (axis, at) => axis === 'y' ? ewName[Math.round(at / C)] : nsName[Math.round(at / C)];
  let mainRuns = 0, taps = 0;
  for (const e of [...edges.values()].sort((p, q) => (p.axis + p.at + ':' + p.from).localeCompare(q.axis + q.at + ':' + q.from))) {
    const street = nameOf(e.axis, e.at) || 'the street';
    for (const kind of ['water', 'sewer']) {
      const d = defaultFor(e.axis, e.at, kind);
      const ivs = mainsOn(e.axis, e.at, kind).filter(m => m.b > e.from && m.a < e.to).sort((p, q) => p.a - q.a);
      let prev = {pos: e.from, off: d.off, z: d.z};
      const fill = (to, off, z) => {
        if (to - prev.pos <= 300) return;
        const pts = [P(e.axis, prev.pos, e.at + prev.off, prev.z)];
        if (Math.abs(off - prev.off) > 50 || z !== prev.z) pts.push(P(e.axis, Math.max(prev.pos, to - 900), e.at + prev.off, prev.z));
        pts.push(P(e.axis, to, e.at + off, z));
        calls.push({tool: 'place_line', args: {discipline: 'plumbing', color: kind === 'water' ? 10 : 9, pts, meta: {part: kind + ' main in ' + street + ', stitched between blocks', street, steward: 'joins the ' + kind + ' main across chunks'}}});
        mainRuns++;
      };
      for (const m of ivs) { if (m.a > prev.pos) fill(m.a, m.off, m.z); if (m.b > prev.pos) prev = {pos: m.b, off: m.off, z: m.z}; }
      fill(e.to, d.off, d.z);
    }
  }
  // services and laterals that stop in the street get a tap down to the main of that street
  for (const r of plumb) {
    const kind = kindOf(r); if (!kind || isMain(r) || r.agent === ID) continue;
    for (const end of [r.pts[0], r.pts[r.pts.length - 1]]) {
      if (end[2] > -300) continue;
      let best = null;
      for (const axis of ['y', 'x']) { const at = Math.round(across(end, axis) / C) * C, dist = Math.abs(across(end, axis) - at);
        if (dist < PORT - 100 && (!best || dist < best.dist)) best = {axis, at, dist}; }
      if (!best) continue;
      const d = defaultFor(best.axis, best.at, kind), target = best.at + d.off;
      if (Math.abs(across(end, best.axis) - target) < 600) continue;
      const covered = mainsOn(best.axis, best.at, kind).some(m => Math.abs(m.off - (across(end, best.axis) - best.at)) < 600 && along(end, best.axis) >= m.a - 300 && along(end, best.axis) <= m.b + 300);
      if (covered) continue;
      const street = nameOf(best.axis, best.at) || 'the street';
      calls.push({tool: 'place_line', args: {discipline: 'plumbing', color: kind === 'water' ? 10 : 9, pts: [end.slice(), P(best.axis, along(end, best.axis), target, d.z)], meta: {part: (kind === 'water' ? 'water service tap' : 'sewer lateral connection') + ' to the ' + street + ' main', street, steward: 'connects a builder service to the main'}}});
      taps++;
    }
  }
  log.push('water and sewer: ' + mainRuns + ' main runs, ' + taps + ' service taps');
}

// ---------- fuel tanks at fuel stations: buried cylinders below grade ----------
{
  const stations = new Set(recs.filter(r => r.meta && /dispenser/i.test(String(r.meta.part || ''))).map(r => r.cx + ',' + r.cy));
  const isFuelTank = r => { const p = String((r.meta && r.meta.part) || ''); return /tank/i.test(p) && /fuel|gasoline|unleaded|regular|premium|diesel|underground|e85|kerosene/i.test(p) && !/stand|farm|water|pressure|septic|stock|compressor|heater|filter|toilet|vent|fill|shell|bedding|pit|riser/i.test(p); };
  let fixed = 0;
  const tanks = recs.filter(r => r.agent !== ID && r.kind === 'line' && stations.has(r.cx + ',' + r.cy) && isFuelTank(r));
  const pit = {x0: 1e12, y0: 1e12, x1: -1e12, y1: -1e12};
  for (const r of tanks) {
    const zs = r.pts.map(p => p[2]), flat = Math.max(...zs) - Math.min(...zs) < 50;
    const above = Math.max(...zs) > -900;
    if (!above && !flat) continue;
    const xs = r.pts.map(p => p[0]), ys = r.pts.map(p => p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const alongX = (x1 - x0) >= (y1 - y0), len = Math.max(alongX ? x1 - x0 : y1 - y0, 4000);
    const D = Math.max(1800, Math.min(3658, alongX ? y1 - y0 : x1 - x0)), R = Math.round(D / 2);
    const top = -1000, zc = top - R, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const name = String(r.meta.part).replace(/\s*(underground\s*)?(storage\s*)?tank.*$/i, '').trim() || 'fuel';
    const reason = above ? 'fuel tank at a fuel station stood at or above grade; replaced with a buried tank below grade' : 'underground fuel tank was drawn as a flat outline that read as a slab; replaced with a buried cylinder below grade';
    calls.push({tool: 'steward_hide', args: {id: r.id, reason}});
    const a0 = (alongX ? cx : cy) - len / 2, a1 = (alongX ? cx : cy) + len / 2, c = alongX ? cy : cx;
    const pt = (a, s, z) => alongX ? [Math.round(a), Math.round(s), Math.round(z)] : [Math.round(s), Math.round(a), Math.round(z)];
    const meta = (part) => ({part: name + ' underground tank ' + part, steward: 'fuel tank moved below grade'});
    for (const a of [a0, a1]) { const ring = []; for (let k = 0; k < 16; k++) { const t = k / 16 * Math.PI * 2; ring.push(pt(a, c + Math.cos(t) * R, zc + Math.sin(t) * R)); }
      calls.push({tool: 'place_line', args: {discipline: 'plumbing', color: r.color ?? 4, pts: ring, closed: true, meta: meta('end cap')}}); }
    for (const [ds, dz] of [[0, R], [0, -R], [R, 0], [-R, 0]]) calls.push({tool: 'place_line', args: {discipline: 'plumbing', color: r.color ?? 4, pts: [pt(a0, c + ds, zc + dz), pt(a1, c + ds, zc + dz)], meta: meta('shell')}});
    calls.push({tool: 'place_line', args: {discipline: 'plumbing', color: 7, pts: [pt((alongX ? cx : cy), c, top), pt((alongX ? cx : cy), c, 0)], meta: meta('submersible pump riser to the manway')}});
    calls.push({tool: 'place_symbol', args: {discipline: 'plumbing', color: 7, type: 'mark', at: pt((alongX ? cx : cy), c, 0), rot: 0, meta: meta('manway at grade')}});
    const cap = recs.find(s => s.kind === 'symbol' && /fill/i.test(String((s.meta && s.meta.part) || '')) && s.at[0] >= x0 - 600 && s.at[0] <= x1 + 600 && s.at[1] >= y0 - 600 && s.at[1] <= y1 + 600);
    if (cap) calls.push({tool: 'place_line', args: {discipline: 'plumbing', color: 7, pts: [[cap.at[0], cap.at[1], 0], [cap.at[0], cap.at[1], top]], meta: meta('fill pipe down from the fill cap')}});
    const b = alongX ? {x0: a0, x1: a1, y0: c - R, y1: c + R} : {x0: c - R, x1: c + R, y0: a0, y1: a1};
    pit.x0 = Math.min(pit.x0, b.x0); pit.y0 = Math.min(pit.y0, b.y0); pit.x1 = Math.max(pit.x1, b.x1); pit.y1 = Math.max(pit.y1, b.y1); pit.bottom = Math.min(pit.bottom ?? 0, zc - R);
    fixed++;
  }
  if (fixed) {
    const g = 600, X0 = Math.round(pit.x0 - g), X1 = Math.round(pit.x1 + g), Y0 = Math.round(pit.y0 - g), Y1 = Math.round(pit.y1 + g), zb = Math.round(pit.bottom - 300);
    calls.push({tool: 'place_hatch', args: {discipline: 'paving', color: 7, pts: [[X0, Y0, 0], [X1, Y0, 0], [X1, Y1, 0], [X0, Y1, 0]], pattern: 'cross', spacing: 900, angle: 0, meta: {part: 'concrete tank pit cover slab over the buried fuel tanks', steward: 'fuel tank moved below grade'}}});
    calls.push({tool: 'place_hatch', args: {discipline: 'paving', color: 9, pts: [[X0, Y0, zb], [X1, Y0, zb], [X1, Y1, zb], [X0, Y1, zb]], pattern: 'dots', spacing: 400, angle: 0, meta: {part: 'pea gravel bedding under the buried fuel tanks', steward: 'fuel tank moved below grade'}}});
    for (const [x, y] of [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]) calls.push({tool: 'place_line', args: {discipline: 'plumbing', color: 9, pts: [[x, y, 0], [x, y, zb]], meta: {part: 'tank pit excavation corner', steward: 'fuel tank moved below grade'}}});
  }
  log.push('fuel tanks moved below grade: ' + fixed);
}

if (!calls.length) { console.log('Steward: nothing missing between chunks today.'); process.exit(0); }
fs.mkdirSync(path.join(repo, 'contrib', ID), {recursive: true});
const ap = path.join(repo, 'contrib', ID, 'agent.json');
fs.writeFileSync(ap, JSON.stringify({name: 'Agent Tangerine', model: 'Claude Opus 5.5', about: 'Ties the city together between chunks: pole lines, telephone and power wires, water and sewer mains, crosswalks, street lights, and buried fuel tanks.', color: 11}, null, 1) + '\n');
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
