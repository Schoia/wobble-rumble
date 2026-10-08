'use strict';
// Wobble Rumble multiplayer server: serves the game page and runs rooms over WebSockets.
// The server decides the show (votes, rounds, who qualifies). Each player's browser
// simulates its own blob. Rooms hold 2 to 10 players; there are no bots.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');
const MAX = 10;
const MIN = 2;

const MAPS = {
  spinner: { mode: 'race' }, bumper: { mode: 'race' }, gates: { mode: 'race' },
  tiles: { mode: 'survival' }, sweeper: { mode: 'survival' }, coins: { mode: 'collect' },
  crown: { mode: 'race', final: true }, lasttile: { mode: 'survival', final: true },
};
const REG = ['spinner', 'bumper', 'gates', 'tiles', 'sweeper', 'coins'];
const FIN = ['crown', 'lasttile'];
const HUMAN_COLORS = ['#ff4f87', '#ffcb2f', '#22d39b', '#4fb3ff', '#ff8a3d', '#a66bff', '#7be04f', '#3fe0e0'];
const CROWN = [0, 8.1, -65];

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); res.end('Missing public/index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });

const rooms = new Map();
let nextId = 1;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cleanName = s => String(s || '').replace(/[<>&"'\\`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'Blob';
function newCode() { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''); } while (rooms.has(c)); return c; }
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function bcast(r, o) { const s = JSON.stringify(o); for (const m of r.members.values()) if (m.ws.readyState === 1) m.ws.send(s); }
function later(r, ms, fn) { const h = setTimeout(() => { r.timers.delete(h); fn(); }, Math.max(0, ms)); r.timers.add(h); return h; }

function createRoom(pub) {
  const r = { code: newCode(), pub, members: new Map(), hostId: null, w: 0, phaseData: null, timers: new Set(), show: null, bots: [], states: new Map(), autoAt: 0, R: null, vote: null };
  rooms.set(r.code, r);
  setPhase(r, { phase: 'lobby' }, true);
  return r;
}
function setPhase(r, data, newWorld) {
  if (newWorld) { r.w++; r.states.clear(); }
  r.phaseData = Object.assign({}, data, { w: r.w });
  bcast(r, Object.assign({ t: 'phase' }, r.phaseData));
}
const phase = r => r.phaseData.phase;
function roster(r) {
  const inShow = id => !!(r.show && r.show.inShow.has(id));
  return {
    t: 'roster', code: r.code, pub: r.pub, hostId: r.hostId, autoAt: r.autoAt,
    list: [...r.members.values()].map(m => ({ id: m.id, name: m.name, color: m.color, bot: false, inShow: inShow(m.id) }))
      .concat(r.bots.map(b => ({ id: b.id, name: b.name, color: b.color, bot: true, inShow: inShow(b.id) }))),
  };
}
const owns = (r, me, id) => id === me.id || (r.hostId === me.id && r.bots.some(b => b.id === id));
const sanitize = a => a.slice(0, 8).map(v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : 0);

function checkAuto(r) {
  if (!r.pub || phase(r) !== 'lobby') { r.autoAt = 0; return; }
  const n = r.members.size;
  if (n >= MIN && !r.autoAt) {
    r.autoAt = Date.now() + 30000; const at = r.autoAt;
    later(r, 30000, () => { if (r.autoAt === at && phase(r) === 'lobby') startShow(r); });
    bcast(r, roster(r));
  } else if (n < MIN && r.autoAt) { r.autoAt = 0; bcast(r, roster(r)); }
}

function startShow(r) {
  if (r.members.size < MIN) return;
  r.bots = [];
  r.show = { round: 0, played: new Set(), inShow: new Set(r.members.keys()) };
  r.autoAt = 0;
  bcast(r, roster(r));
  gotoVote(r);
}
// The final is played once 3 or fewer remain; before that each round knocks out about a third.
const isFinal = r => r.show.inShow.size <= 3 || r.show.played.size >= REG.length;
function target(r) {
  const n = r.show.inShow.size;
  if (isFinal(r)) return 1;
  return Math.max(2, n - Math.max(1, Math.round(n * 0.3)));
}
function tally(r) { const v = r.vote; return v.opts.map((_, i) => [...v.votes].filter(([, x]) => x === i).map(([id]) => id)); }
function pushVotes(r) { const t = tally(r); r.phaseData.tally = t; bcast(r, { t: 'votes', tally: t }); }
function gotoVote(r) {
  const ids = [...r.show.inShow];
  if (ids.length <= 1) { crowned(r, ids[0] || null); return; }
  const final = isFinal(r);
  const opts = final ? FIN.slice() : shuffle(REG.filter(id => !r.show.played.has(id))).slice(0, 3);
  const v = { opts, votes: new Map(), revealed: false };
  r.vote = v;
  const endsAt = Date.now() + 10000;
  setPhase(r, { phase: 'vote', opts, round: r.show.round, final, target: target(r), left: ids.length, endsAt, tally: opts.map(() => []) }, true);
  later(r, 10000, () => { if (r.vote === v) reveal(r); });
}
function maybeEndVote(r) {
  const v = r.vote; if (!v || v.revealed || v.ending) return;
  if ([...r.members.keys()].every(id => v.votes.has(id))) { v.ending = true; later(r, 1200, () => { if (r.vote === v) reveal(r); }); }
}
function reveal(r) {
  const v = r.vote; if (!v || v.revealed) return; v.revealed = true;
  const counts = v.opts.map((_, i) => [...v.votes.values()].filter(x => x === i).length);
  const max = Math.max(...counts); const top = counts.map((c, i) => i).filter(i => counts[i] === max);
  const win = top[Math.floor(Math.random() * top.length)];
  setPhase(r, Object.assign({}, r.phaseData, { phase: 'reveal', win, tie: top.length > 1 }), false);
  r.vote = null;
  later(r, 4200, () => startRound(r, v.opts[win]));
}
function coinPos(arr) {
  let x, z, g = 0;
  do { x = Math.round((Math.random() * 23 - 11.5) * 100) / 100; z = Math.round((Math.random() * 23 - 11.5) * 100) / 100; g++; }
  while (g < 60 && (Math.hypot(x, z) < 1.8 || arr.some(o => o.active && Math.hypot(o.x - x, o.z - z) < 2)));
  return { x, z };
}
function startRound(r, mapId) {
  if (!r.show) return;
  const def = MAPS[mapId]; r.show.played.add(mapId);
  const actors = [...r.show.inShow];
  const now = Date.now(), startAt = now + 6000;
  const dur = def.mode === 'race' ? (def.final ? 150 : 120) : def.mode === 'survival' ? (def.final ? 0 : 70) : 45;
  const R = { map: mapId, mode: def.mode, final: !!def.final, round: r.show.round, actors, target: target(r), startAt, dur, seed: Math.floor(Math.random() * 1e9), finished: [], out: [], winner: null, coins: {}, coinArr: null, tiles: new Set(), doors: new Set(), log: [], over: false };
  if (def.mode === 'collect') { R.coinArr = []; for (let i = 0; i < 10; i++) R.coinArr.push(Object.assign({ active: true }, coinPos(R.coinArr))); }
  r.R = R;
  setPhase(r, { phase: 'round', map: mapId, seed: R.seed, actors, target: R.target, startAt, dur, round: r.show.round, final: !!def.final,
    coins: R.coinArr ? R.coinArr.map(c => [c.x, c.z, 1]) : null, log: R.log }, true);
  if (dur) later(r, startAt - now + dur * 1000, () => { if (r.R === R) endRound(r); });
}
function evt(r, o) { r.R.log.push(o); bcast(r, Object.assign({ t: 'ev' }, o)); }
function roundEvent(r, me, m) {
  const R = r.R; if (!R || R.over || Date.now() < R.startAt - 300) return;
  const id = typeof m.id === 'string' ? m.id : null;
  const mine = id && owns(r, me, id) && R.actors.includes(id) && r.show.inShow.has(id);
  switch (m.k) {
    case 'fin':
      if (R.mode === 'race' && !R.final && mine && !R.finished.includes(id) && !R.out.includes(id)) {
        R.finished.push(id); evt(r, { k: 'fin', id });
        if (R.finished.length >= R.target) endRound(r); else checkRaceDone(r);
      } break;
    case 'crown':
      if (R.mode === 'race' && R.final && mine && !R.winner) { R.winner = id; evt(r, { k: 'crown', id }); endRound(r); } break;
    case 'out':
      if (R.mode === 'survival' && mine) markOut(r, id); break;
    case 'tile': {
      const i = m.i | 0;
      if (i >= 0 && i < 400 && !R.tiles.has(i)) { R.tiles.add(i); evt(r, { k: 'tile', i, t: Math.max(0, (Date.now() - R.startAt) / 1000) }); }
    } break;
    case 'door': {
      const a = m.r | 0, b = m.i | 0, key = a + ':' + b;
      if (a >= 0 && a < 8 && b >= 0 && b < 8 && !R.doors.has(key)) { R.doors.add(key); evt(r, { k: 'door', r: a, i: b }); }
    } break;
    case 'coin': {
      const ci = m.i | 0, c = R.coinArr && R.coinArr[ci];
      if (c && c.active && mine && !R.out.includes(id)) {
        c.active = false; R.coins[id] = (R.coins[id] || 0) + 1; evt(r, { k: 'coin', i: ci, id, n: R.coins[id] });
        later(r, 800 + Math.random() * 1700, () => { if (r.R !== R || R.over) return; Object.assign(c, coinPos(R.coinArr)); c.active = true; evt(r, { k: 'coinpos', i: ci, x: c.x, z: c.z }); });
      }
    } break;
    case 'cfall':
      if (R.mode === 'collect' && mine) { R.coins[id] = Math.max(0, (R.coins[id] || 0) - 2); evt(r, { k: 'coins', id, n: R.coins[id] }); } break;
  }
}
function markOut(r, id) {
  const R = r.R; if (!R || R.out.includes(id)) return;
  R.out.push(id); evt(r, { k: 'out', id });
  if (R.over) return;
  if (R.mode === 'survival') { if (R.actors.filter(a => !R.out.includes(a)).length <= R.target) endRound(r); }
  else checkRaceDone(r);
}
function checkRaceDone(r) { const R = r.R; if (R && R.mode === 'race' && !R.over && R.actors.every(a => R.finished.includes(a) || R.out.includes(a))) endRound(r); }
function endRound(r) {
  const R = r.R; if (!R || R.over) return;
  R.over = true; evt(r, { k: 'end' });
  later(r, 2600, () => results(r, R));
}
function results(r, R) {
  if (r.R !== R || !r.show) return;
  const st = id => r.states.get(id);
  const valid = R.actors.filter(id => r.show.inShow.has(id));
  let q;
  if (R.mode === 'race') {
    if (R.final) {
      const d = id => { const s = st(id); return s ? Math.hypot(s[0] - CROWN[0], s[1] - CROWN[1], s[2] - CROWN[2]) : 1e9; };
      q = R.winner ? [R.winner] : valid.filter(id => !R.out.includes(id)).sort((a, b) => d(a) - d(b)).slice(0, 1);
    } else {
      q = R.finished.filter(id => valid.includes(id));
      const z = id => { const s = st(id); return s ? s[2] : 1e9; };
      const rest = valid.filter(id => !q.includes(id) && !R.out.includes(id)).sort((a, b) => z(a) - z(b));
      while (q.length < R.target && rest.length) q.push(rest.shift());
    }
  } else if (R.mode === 'survival') {
    const alive = valid.filter(id => !R.out.includes(id));
    if (!alive.length) { const last = R.out.slice().reverse().find(id => valid.includes(id)); q = last ? [last] : []; }
    else if (R.final && alive.length > 1) q = [alive[Math.floor(Math.random() * alive.length)]];
    else q = alive;
  } else {
    q = valid.slice().sort((a, b) => (R.coins[b] || 0) - (R.coins[a] || 0) || Math.random() - 0.5).slice(0, R.target);
  }
  if (!q.length && valid.length) q = [valid[0]];
  r.show.inShow = new Set(q);
  r.R = null;
  bcast(r, roster(r));
  if (R.final || q.length <= 1) { crowned(r, q[0] || null); return; }
  const next = Date.now() + 8000;
  setPhase(r, { phase: 'results', map: R.map, round: r.show.round, qualified: q, actors: R.actors, coins: R.coins, next }, false);
  later(r, 8000, () => { if (!r.show) return; r.show.round++; gotoVote(r); });
}
function crowned(r, winner) {
  r.R = null; r.vote = null;
  setPhase(r, { phase: 'crowned', winner, next: Date.now() + 12000 }, true);
  later(r, 12000, () => backToLobby(r));
}
function backToLobby(r) {
  r.show = null; r.bots = []; r.vote = null; r.R = null;
  setPhase(r, { phase: 'lobby' }, true);
  bcast(r, roster(r));
  checkAuto(r);
}

function join(ws, m) {
  const name = cleanName(m.name);
  const color = HUMAN_COLORS.includes(m.color) ? m.color : HUMAN_COLORS[0];
  let r;
  if (m.mode === 'create') r = createRoom(false);
  else if (m.mode === 'code') {
    r = rooms.get(String(m.code || '').toUpperCase().replace(/[^A-Z]/g, ''));
    if (!r) { send(ws, { t: 'err', msg: 'No room with that code. Check the letters and try again.' }); return null; }
    if (r.members.size >= MAX) { send(ws, { t: 'err', msg: 'That room is full (10 players).' }); return null; }
  } else {
    const pubs = [...rooms.values()].filter(x => x.pub && x.members.size < MAX);
    r = pubs.find(x => phase(x) === 'lobby') || pubs[0] || createRoom(true);
  }
  const me = { id: 'h' + (nextId++), name, color, ws };
  r.members.set(me.id, me);
  if (!r.hostId || !r.members.has(r.hostId)) r.hostId = me.id;
  send(ws, { t: 'welcome', you: me.id, now: Date.now() });
  bcast(r, roster(r));
  send(ws, Object.assign({ t: 'phase' }, r.phaseData));
  checkAuto(r);
  return { r, me };
}
function leave(r, me) {
  r.members.delete(me.id); r.states.delete(me.id);
  if (!r.members.size) { for (const h of r.timers) clearTimeout(h); r.timers.clear(); rooms.delete(r.code); return; }
  if (r.hostId === me.id) r.hostId = r.members.keys().next().value;
  if (r.show && r.show.inShow.has(me.id)) {
    r.show.inShow.delete(me.id);
    if (r.R && !r.R.over && r.R.actors.includes(me.id)) markOut(r, me.id);
  }
  if (r.vote) { r.vote.votes.delete(me.id); pushVotes(r); maybeEndVote(r); }
  bcast(r, roster(r));
  checkAuto(r);
}

wss.on('connection', ws => {
  let ctx = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'ping') { send(ws, { t: 'pong', c: m.c, s: Date.now() }); return; }
    if (m.t === 'join') { if (!ctx) ctx = join(ws, m); return; }
    if (!ctx) return;
    const { r, me } = ctx; const ph = phase(r);
    switch (m.t) {
      case 's': if (Array.isArray(m.a) && m.w === r.w) r.states.set(me.id, sanitize(m.a)); break;
      case 'b':
        if (r.hostId === me.id && Array.isArray(m.a) && m.w === r.w)
          for (const s of m.a) if (Array.isArray(s) && r.bots.some(b => b.id === s[0])) r.states.set(s[0], sanitize(s.slice(1)));
        break;
      case 'start': if (r.hostId === me.id && ph === 'lobby') startShow(r); break;
      case 'vote':
        if (ph === 'vote' && r.vote && Number.isInteger(m.i) && m.i >= 0 && m.i < r.vote.opts.length) { r.vote.votes.set(me.id, m.i); pushVotes(r); maybeEndVote(r); }
        break;
      case 'ev': if (ph === 'round') roundEvent(r, me, m); break;
    }
  });
  ws.on('close', () => { if (ctx) leave(ctx.r, ctx.me); ctx = null; });
});

setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (!r.states.size) continue;
    const e = [];
    for (const [id, s] of r.states) e.push([id].concat(s));
    bcast(r, { t: 'snap', ts: now, w: r.w, e });
  }
}, 50);
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);

server.listen(PORT, () => console.log('Wobble Rumble listening on port ' + PORT));
