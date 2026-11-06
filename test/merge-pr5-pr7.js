// Mock-only regression for the PR #5 / PR #7 merge.
// Drives server.js and the mock panel over HTTP. No serial devices, GPIO, or live lift.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const servers = [];
let portSeq = 21000 + Math.floor(Math.random() * 20000);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function cleanPositionFiles() {
  for (const name of ['last_position.json', 'last_position.mock.json', 'last_position.json.tmp', 'last_position.mock.json.tmp']) {
    try { fs.unlinkSync(path.join(ROOT, name)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

function readMockPosition() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'last_position.mock.json'), 'utf8'));
}

function httpCall(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { json = null; } }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startServer(extra = {}) {
  const ports = { PORT: String(portSeq++), MOCK_PANEL_PORT: String(portSeq++) };
  let logBuf = '';
  const env = {
    ...process.env,
    DISABLE_AUTH: 'true',
    USERNAME: 'lift-test',
    PASSWORD: 'lift-test',
    ACCESS_TOKEN_SECRET: 'test-access-secret',
    REFRESH_TOKEN_SECRET: 'test-refresh-secret',
    ...ports,
    ...extra
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const take = buf => {
    logBuf += buf.toString();
    if (logBuf.length > 500000) logBuf = logBuf.slice(-400000);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const srv = { child, logBuf: () => logBuf, port: Number(ports.PORT), panel: Number(ports.MOCK_PANEL_PORT) };
  servers.push(srv);
  return srv;
}

function logText(srv) { return srv.logBuf(); }

async function stopServer(srv) {
  if (!srv || srv.child.exitCode !== null || srv.child.killed) return;
  srv.child.kill('SIGKILL');
  await Promise.race([
    new Promise(resolve => srv.child.once('exit', resolve)),
    sleep(2000)
  ]);
}

async function waitFor(label, fn, ms) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < ms) {
    try {
      const value = await fn();
      if (value) return value;
      last = JSON.stringify(value);
    } catch (err) {
      if (!err || (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET')) throw err;
      last = err.message;
    }
    await sleep(40);
  }
  throw new Error(`timeout: ${label} (last ${last})`);
}

async function ready(srv) {
  await waitFor('mock panel', async () => logText(srv).includes('Mock panel running'), 15000);
  return waitFor('status', async () => {
    const res = await httpCall(srv.port, 'GET', '/status');
    if (res.status === 200 && res.json && res.json.currentPosition && res.json.currentPosition !== 'none') return res.json;
    return null;
  }, 5000);
}

async function status(srv) {
  const res = await httpCall(srv.port, 'GET', '/status');
  assert(res.status === 200 && res.json, `status failed: ${res.status} ${res.text}`);
  // /status has relays and board alerts. The mock panel state has liftState.
  const panelRes = await httpCall(srv.panel, 'GET', '/state');
  if (panelRes.status === 200 && panelRes.json) res.json.liftState = panelRes.json.liftState;
  return res.json;
}

async function panel(srv, level, action) {
  const res = await httpCall(srv.panel, 'POST', `/action/${encodeURIComponent(level)}/${action}`);
  return res;
}

async function panelState(srv) {
  const res = await httpCall(srv.panel, 'GET', '/state');
  assert(res.status === 200 && res.json, `panel state failed: ${res.status}`);
  return res.json;
}

function levelHere(state, level) {
  const row = state.levels.find(l => l.level === level);
  assert(row, `missing mock level ${level}`);
  return row.liftHere;
}

function assertNoStop(srv, why) {
  assert(!/STOP:/.test(logText(srv)), `${why}: server logged STOP\n${logText(srv).slice(-2000)}`);
}

async function scenario(name, fn) {
  console.log(`\n== ${name}`);
  cleanPositionFiles();
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.stack || err.message}`);
    for (const srv of servers) {
      const tail = logText(srv).trim().split('\n').slice(-30).join('\n');
      if (tail) console.error(`--- server :${srv.port} ---\n${tail}`);
    }
    throw err;
  } finally {
    while (servers.length) await stopServer(servers.pop());
    cleanPositionFiles();
  }
}

function assertSourceContract() {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const mock = fs.readFileSync(path.join(ROOT, 'mock_panel.js'), 'utf8');
  const firmware = fs.readFileSync(path.join(ROOT, 'level_arduino/src/main.cpp'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'client/src/LiftControl.js'), 'utf8');
  assert(/BOARD_SILENT_MS = Number\(process\.env\.BOARD_SILENT_MS\) \|\| 3000/.test(server), '3s silence default missing');
  assert(/LEGACY_BOARD_SILENT_MS = 6000/.test(server), 'legacy 6s fallback missing');
  assert(/OVERSHOOT_IGNORE_MS = Number\(process\.env\.OVERSHOOT_IGNORE_MS\) \|\| 500/.test(server), '500ms overshoot window missing');
  assert(/isMoveActive\(\) && !port\.silenceReconnect\) stopMotion/.test(server), 'silence reconnect must not stop a move');
  assert(/reconnect deferred until the lift is idle/.test(server), 'idle-only reconnect missing');
  assert(/move in progress continues/.test(server), 'alert-only silence copy missing');
  assert(/setInterval\(\(\) => send\('<3'\), 1000\)/.test(mock), 'mock heartbeat is not 1s');
  assert(/HEARTBEAT_INTERVAL = 1000/.test(firmware), 'firmware heartbeat is not 1s');
  assert(/status\.boardAlerts/.test(client), 'client board alert banner missing');
  assert(/gapFrom\(levelLabel, 1\)/.test(server), 'gapFrom missing from line-lost handling');
  assert(/levelLabel === currentPosition/.test(server), 'foreign line-lost guard missing');
  console.log('ok source contract (1s heartbeat, 3s silence, legacy 6s, 500ms overshoot, idle reconnect guard)');
}

async function silenceTiming() {
  const srv = startServer();
  await ready(srv);
  // Floor 2 is silenced before a second heartbeat, so it stays on the legacy 6s threshold.
  // Floor B keeps the 1s heartbeat long enough to be marked fast, then goes quiet (3s).
  const silenced = await panel(srv, '2', 'silence');
  assert(silenced.status === 200, `silence 2 failed ${silenced.status} ${silenced.text}`);
  const t0 = Date.now();
  await sleep(1200);
  assert((await panel(srv, 'B', 'silence')).status === 200, 'silence B failed');
  const tB = Date.now();
  await sleep(1000);
  let s = await status(srv);
  assert(s.boards.B === true && !s.boardAlerts.some(a => a.level === 'B'), `fast board B alerted before 3s of silence: ${JSON.stringify(s.boards)} ${JSON.stringify(s.boardAlerts)}`);
  assert(s.boards['2'] === true && !s.boardAlerts.some(a => a.level === '2'), `legacy board 2 alerted early: ${JSON.stringify(s.boards)} ${JSON.stringify(s.boardAlerts)}`);
  s = await waitFor('fast board alert', async () => {
    const now = await status(srv);
    return now.boardAlerts.some(a => a.level === 'B') ? now : null;
  }, 4000);
  const fastDelay = Date.now() - tB;
  assert(fastDelay >= 1500 && fastDelay <= 4500, `fast board alert delay ${fastDelay}ms was not about 3s`);
  assert(s.boards['2'] === true && !s.boardAlerts.some(a => a.level === '2'), `legacy board 2 alerted before 6s (fast alert at ${fastDelay}ms, age ${Date.now() - t0}ms)`);
  s = await waitFor('legacy board alert', async () => {
    const now = await status(srv);
    return now.boardAlerts.some(a => a.level === '2') ? now : null;
  }, 8000);
  const legacyDelay = Date.now() - t0;
  assert(legacyDelay >= 6000, `legacy board alerted at ${legacyDelay}ms, expected about 6s`);
  assert(s.up === 0 && s.down === 0 && s.liftState === 'Idle', `silence alert changed idle motion ${JSON.stringify(s)}`);
  assertNoStop(srv, 'idle silence');
  assert(/ALERT: board B silent/.test(logText(srv)) && /ALERT: board 2 silent/.test(logText(srv)), 'alert logs missing');
  assert(!/move in progress continues/.test(logText(srv)), 'idle alert claimed a move was in progress');
}

async function doorInterlocks() {
  const srv = startServer();
  await ready(srv);
  const opened = await panel(srv, 'G', 'force');
  assert(opened.status === 200, `force open failed ${opened.text}`);
  await sleep(200);
  let s = await status(srv);
  assert(!String(s.displayMessage).includes('not moving'), `spurious can't-lock aborted an idle lift: ${s.displayMessage}`);
  assertNoStop(srv, 'force open while idle');
  const requestedAt = Date.now();
  const trip = await httpCall(srv.port, 'POST', '/floor', { floor: '1' });
  assert(trip.status === 200, `floor request failed ${trip.status} ${trip.text}`);
  s = await waitFor('door abort', async () => {
    const now = await status(srv);
    return String(now.displayMessage).includes('Door open at floor G, lift not moving') ? now : null;
  }, 1000);
  assert(Date.now() - requestedAt < 1000, 'door-open refusal waited for the lock timeout');
  assert(s.up === 0 && s.down === 0 && s.liftState === 'Idle', `motor ran with the door open ${JSON.stringify(s)}`);
  await sleep(6200);
  s = await status(srv);
  assert(s.displayMessage === 'Door open at floor G, lift not moving', `door alert was not held past 5s: ${s.displayMessage}`);

  assert((await panel(srv, 'G', 'close')).status === 200, 'close G failed');
  await sleep(100);
  for (const level of ['B', 'G', '1', '2']) assert((await panel(srv, level, 'silence')).status === 200, `silence ${level}`);
  const lockedAt = Date.now();
  assert((await httpCall(srv.port, 'POST', '/floor', { floor: '1' })).status === 200, 'second floor request failed');
  s = await waitFor('not locked', async () => {
    const now = await status(srv);
    return String(now.displayMessage).includes('Door not locked') ? now : null;
  }, 4500);
  assert(Date.now() - lockedAt >= 2500, 'closed-but-silent doors aborted before the lock timeout');
  assert(String(s.displayMessage).includes('lift not moving'), s.displayMessage);
  assert(!String(s.displayMessage).includes('Door open'), `closed doors were reported open: ${s.displayMessage}`);
  assert(s.up === 0 && s.down === 0, 'motor started without door locks');

  for (const level of ['B', 'G', '1', '2']) assert((await panel(srv, level, 'silence')).status === 200, `unsilence ${level}`);
  await sleep(300);
  assert((await httpCall(srv.port, 'POST', '/settings/maintenance/enabled', { value: true })).status === 200, 'maintenance on failed');
  assert((await panel(srv, 'G', 'force')).status === 200, 'force open under maintenance failed');
  assert((await httpCall(srv.port, 'POST', '/floor', { floor: '1' })).status === 200, 'maintenance trip failed');
  s = await waitFor('maintenance move', async () => {
    const now = await status(srv);
    return now.up === 1 && now.liftState === 'Going UP' ? now : null;
  }, 1500);
  assert(!String(s.displayMessage).includes('not moving'), 'maintenance mode still blocked on an open door');
  assert((await panel(srv, '2', 'force')).status === 200, 'force open during maintenance move failed');
  await sleep(400);
  s = await status(srv);
  assert(s.up === 1 && s.liftState === 'Going UP', `maintenance mode stopped for a door: ${s.displayMessage}`);
  assert((await httpCall(srv.port, 'POST', '/stop')).status === 200, 'stop failed');
  await waitFor('stopped', async () => {
    const now = await status(srv);
    return now.up === 0 && now.down === 0 && now.liftState === 'Idle' ? now : null;
  }, 2000);
  assert((await httpCall(srv.port, 'POST', '/settings/maintenance/enabled', { value: false })).status === 200, 'maintenance off failed');
  for (const level of ['G', '2']) assert((await panel(srv, level, 'close')).status === 200, `close ${level}`);
  await sleep(200);
  assert((await httpCall(srv.port, 'POST', '/settings/manual/up', { value: true })).status === 200, 'manual up failed');
  await waitFor('manual moving', async () => (await status(srv)).liftState === 'Manual UP', 2000);
  assert((await panel(srv, '1', 'force')).status === 200, 'force open during move failed');
  s = await waitFor('door stops move', async () => {
    const now = await status(srv);
    return String(now.displayMessage).includes('Door open at floor 1, lift stopped') ? now : null;
  }, 1500);
  assert(s.up === 0 && s.down === 0 && s.liftState === 'Idle', `door did not stop the move ${JSON.stringify(s)}`);
}

async function waitUntilFloor(srv, floor, ms) {
  let sawMoving = false;
  return waitFor(`arrival ${floor}`, async () => {
    const now = await status(srv);
    if (now.up === 1 || now.down === 1) sawMoving = true;
    if (sawMoving && now.up === 0 && now.down === 0 && now.liftState === 'Idle' && now.currentPosition !== floor) {
      throw new Error(`stopped away from ${floor} at ${now.currentPosition} display=${now.displayMessage} target=${now.targetLevel}`);
    }
    if (now.currentPosition === floor && now.liftState === 'Idle' && now.up === 0 && now.down === 0 && sawMoving) return now;
    return null;
  }, ms);
}

async function overshootPersistAndStale() {
  const srv = startServer();
  await ready(srv);
  assert((await status(srv)).currentPosition === 'G', 'mock did not start at G');
  assert((await httpCall(srv.port, 'POST', '/settings/manual/up', { value: true })).status === 200, 'manual up failed');
  await waitFor('left G', async () => {
    const now = await status(srv);
    return now.currentPosition !== 'G' ? now : null;
  }, 4000);
  assert((await httpCall(srv.port, 'POST', '/settings/manual/up', { value: false })).status === 200, 'manual stop failed');
  let s = await status(srv);
  assert(s.currentPosition === 'G', `line lost just before stop was not ignored: ${s.currentPosition}`);
  assert(/OVERSHOOT IGNORED at level G: line lost (\d+) ms before the stop/.test(logText(srv)), logText(srv).slice(-800));
  const beforeMs = Number(logText(srv).match(/line lost (\d+) ms before the stop/)[1]);
  assert(beforeMs <= 500, `ignore window exceeded: ${beforeMs}ms`);
  await sleep(400);
  assert((await status(srv)).currentPosition === 'G', 'coast after the early stop left the floor');

  assert((await httpCall(srv.port, 'POST', '/floor', { floor: '1' })).status === 200, 'trip to 1 failed');
  await waitUntilFloor(srv, '1', 25000);
  await sleep(700);
  s = await status(srv);
  assert(s.currentPosition === '1', `inside-window coast was not ignored: ${s.currentPosition} ${s.displayMessage}`);
  assert(/OVERSHOOT IGNORED at level 1: line lost \d+ ms after the stop/.test(logText(srv)), 'missing after-stop ignore log');
  const state = await panelState(srv);
  assert(levelHere(state, '1'), 'ignored overshoot cleared presence');
  const saved = readMockPosition();
  assert(saved.floor === '1' && saved.viaOvershoot === true && saved.stale === false && saved.overshotDir === null, `bad saved position ${JSON.stringify(saved)}`);

  await stopServer(srv);
  const restarted = startServer();
  await ready(restarted);
  assert(/Position restored from last_position\.mock\.json: floor 1/.test(logText(restarted)), logText(restarted).slice(-1000));
  assert(/overshoot ignored/.test(logText(restarted)), 'restore did not mention ignored overshoot');
  s = await status(restarted);
  assert(s.currentPosition === '1', `restored position ${s.currentPosition}`);
  await sleep(400);
  assert(levelHere(await panelState(restarted), '1'), 'restored overshoot lost presence');
  const still = readMockPosition();
  assert(still.viaOvershoot === true && still.floor === '1', `startup overwrote the saved overshoot ${JSON.stringify(still)}`);

  assert((await httpCall(restarted.port, 'POST', '/floor', { floor: '2' })).status === 200, 'trip to 2 failed');
  await waitFor('motor on for stale kill', async () => (await status(restarted)).up === 1, 2000);
  const mid = readMockPosition();
  assert(mid.stale === true && mid.floor === '1', `move did not mark floor 1 stale ${JSON.stringify(mid)}`);
  await stopServer(restarted);
  const afterKill = startServer();
  await ready(afterKill);
  assert(/Saved position ignored \(lift moved after it was saved\)/.test(logText(afterKill)), logText(afterKill).slice(-1200));
  assert(!/Position restored/.test(logText(afterKill)), 'stale file was restored');
  s = await status(afterKill);
  assert(s.currentPosition === 'G', `stale restart should boot at G, not the floor from mid-move, got ${s.currentPosition}`);
}

async function overshootOutsideWindow() {
  const srv = startServer();
  await ready(srv);
  const outside = await panel(srv, '_', 'overshoot');
  assert(outside.status === 200, `overshoot toggle failed ${outside.text}`);
  assert(/after 800 ms/.test((await panelState(srv)).overshoot), 'coast did not move outside the 500ms window');
  assert((await httpCall(srv.port, 'POST', '/floor', { floor: '1' })).status === 200, 'trip to 1 failed');
  await waitUntilFloor(srv, '1', 25000);
  const idleAt = Date.now();
  await sleep(400);
  assert((await status(srv)).currentPosition === '1', 'position changed before the outside-window coast');
  assert(!/OVERSHOOT IGNORED/.test(logText(srv)), 'outside-window coast was ignored');
  await sleep(Math.max(0, 1300 - (Date.now() - idleAt)));
  assert(/LIFT OVERSHOT @ level 1/.test(logText(srv)), 'real overshoot was not recorded');
  assert(!levelHere(await panelState(srv), '1'), 'real overshoot kept presence');
  const overshot = readMockPosition();
  assert(overshot.floor === '1' && overshot.viaOvershoot === false && overshot.overshotDir === 1 && overshot.stale === false, JSON.stringify(overshot));
  assert((await httpCall(srv.port, 'POST', '/floor', { floor: '2' })).status === 200, 'post-overshoot trip failed');
  const s = await status(srv);
  assert(s.currentPosition === '1 - 2', `next move did not start from the overshot gap: ${s.currentPosition}`);
  assert((await httpCall(srv.port, 'POST', '/stop')).status === 200, 'stop failed');
}

async function silenceDuringMove() {
  const srv = startServer();
  await ready(srv);
  await sleep(1500); // let the 1s heartbeat mark boards fast, so silence is the 3s threshold
  assert((await httpCall(srv.port, 'POST', '/floor', { floor: '1' })).status === 200, 'trip failed');
  await waitFor('moving', async () => (await status(srv)).liftState === 'Going UP', 3000);
  assert((await panel(srv, 'B', 'silence')).status === 200, 'silence B failed');
  const alerted = await waitFor('silence alert during move', async () => {
    const now = await status(srv);
    if (now.up !== 1 || now.liftState !== 'Going UP') {
      throw new Error(`move interrupted while waiting for the alert: ${JSON.stringify(now)}`);
    }
    return now.boardAlerts.some(a => a.level === 'B') ? now : null;
  }, 6000);
  assert(alerted.up === 1 && alerted.targetLevel === '1', `non-destination silence changed the trip ${JSON.stringify(alerted)}`);
  assert(alerted.fault === null, `non-destination silence raised a fault ${JSON.stringify(alerted.fault)}`);
  assert(/board B silent for \d+s \(no heartbeat\), move in progress continues/.test(logText(srv)), 'alert did not say the move continues');
  await waitUntilFloor(srv, '1', 25000);
  assert(!/Stopped by time|Serial link lost|Travel limit/.test(logText(srv)), `silence ended the trip early\n${logText(srv).slice(-1500)}`);
  assert((await panel(srv, 'B', 'silence')).status === 200, 'unsilence failed');
  await waitFor('alert cleared', async () => (await status(srv)).boardAlerts.length === 0, 4000);
  assert(/BOARD B back after/.test(logText(srv)), 'alert clear was not logged');
}

async function destinationDiverts() {
  const srv = startServer();
  await ready(srv);
  await sleep(1500); // 1s heartbeat seen twice: destination silence uses the 3s threshold
  assert((await httpCall(srv.port, 'POST', '/floor', { floor: '1' })).status === 200, 'trip failed');
  await waitFor('moving', async () => (await status(srv)).liftState === 'Going UP', 3000);
  assert((await panel(srv, '1', 'silence')).status === 200, 'silence destination failed');
  const diverted = await waitFor('divert', async () => {
    const now = await status(srv);
    if (now.up !== 1) throw new Error(`destination silence stopped the motor: ${JSON.stringify(now)}`);
    return now.targetLevel === '2' ? now : null;
  }, 6000);
  assert(/going to 2/.test(diverted.displayMessage), diverted.displayMessage);
  assert(diverted.fault && diverted.fault.levels.includes('1'), `trip guard fault missing ${JSON.stringify(diverted.fault)}`);
  await waitUntilFloor(srv, '2', 45000);
  assert(!/Stopped by time|Serial link lost/.test(logText(srv)), 'diverted trip was stopped by the silence path');
  assert(/move in progress continues/.test(logText(srv)), 'heartbeat alert did not keep the move');
}

async function travelLimitVersusOvershoot() {
  const srv = startServer({
    SEGMENT_TIMES_UP: '1,1,1',
    SEGMENT_TIMES_DOWN: '1,1,1',
    TRAVEL_MARGIN_S: '1'
  });
  await ready(srv);
  assert((await httpCall(srv.port, 'POST', '/floor', { floor: '1' })).status === 200, 'trip failed');
  await waitFor('motor', async () => (await status(srv)).up === 1, 2000);
  const stopped = await waitFor('travel limit', async () => {
    const now = await status(srv);
    return /Travel limit/.test(String(now.displayMessage)) ? now : null;
  }, 6000);
  assert(stopped.up === 0 && stopped.down === 0 && stopped.liftState === 'Idle', JSON.stringify(stopped));
  assert(stopped.currentPosition === 'G - 1', `travel limit should leave the lift between floors, got ${stopped.currentPosition}`);
  await sleep(500);
  assert((await status(srv)).currentPosition === 'G - 1', 'overshoot rule pulled a late stop back onto the floor');
  assert(!/OVERSHOOT IGNORED/.test(logText(srv)), 'a stop well after line-loss was ignored');
  const saved = readMockPosition();
  assert(saved.stale === true, `travel-limit stop between floors was saved as a confirmed floor ${JSON.stringify(saved)}`);
}

async function mockStartLevel() {
  const srv = startServer({ MOCK_START_LEVEL: 'B' });
  const s = await ready(srv);
  assert(s.currentPosition === 'B', `MOCK_START_LEVEL ignored: ${s.currentPosition}`);
  assert(levelHere(await panelState(srv), 'B'), 'start level sensor was not here');
  assert(!levelHere(await panelState(srv), 'G'), 'another floor also reported here');
  const saved = readMockPosition();
  assert(saved.floor === 'B' && saved.stale === false && saved.viaOvershoot === false, JSON.stringify(saved));
}

function killLeftoverServers() {
  let out = '';
  try { out = execSync('ps -eo pid,args', { encoding: 'utf8' }); } catch { return; }
  for (const line of out.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    if (!/\bnode(?:js)?\s+server\.js\b/.test(match[2])) continue;
    try { process.kill(Number(match[1]), 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function main() {
  killLeftoverServers();
  await sleep(100);
  cleanPositionFiles();
  assertSourceContract();
  await scenario('legacy 6s vs fast 3s silence, idle, no stop', silenceTiming);
  await scenario('door open, door not locked, maintenance skip, door stops a move', doorInterlocks);
  await scenario('travel limit stays between floors outside the overshoot window', travelLimitVersusOvershoot);
  await scenario('MOCK_START_LEVEL when no saved floor', mockStartLevel);
  await scenario('overshoot before and after stop, restore, stale kill', overshootPersistAndStale);
  await scenario('overshoot outside the window then the next move uses the gap', overshootOutsideWindow);
  await scenario('non-destination silence alerts and the move finishes', silenceDuringMove);
  await scenario('silent destination diverts and does not stop midway', destinationDiverts);
  cleanPositionFiles();
  console.log('\nall merge regression scenarios passed');
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
