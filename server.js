require('dotenv').config();
const express = require('express');

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { execSync } = require('child_process');
const path = require('path');


// Virtual lift state variables
let virtualLiftPosition = 0; // Initial position at G level
let targetLevel = 'none'; // Initial target level
let virtualLiftMoveInterval; // Variable to hold the interval
let mockLiftMode = false; // Mock lift mode variable, false by default
const mockLevelObject = {}
const mockBoards = {}; // virtual level boards (mock mode only)
const levelPositions = { // Level positions in meters
  'B': -3,
  'G': 0,
  '1': 3,
  '2': 6,
};
const positionTolerance = 0.05; // 1cm tolerance for "LIFT HERE"

let liftOverShot = null;
let lastDir = null;
let initiatedByButton = false;

// Motion safety settings (override with env vars of the same name)
const LEVEL_HEIGHT_M = 3; // distance between two levels, matches levelPositions
// Measured travel time per segment in seconds (button press to LIFT HERE), segment k = between listOfLevels[k] and [k+1]: B-G, G-1, 1-2
const parseSegments = (str, def) => { const a = String(str || '').split(',').map(Number); return a.length === 3 && a.every(n => n > 0) ? a : def; };
const SEGMENT_TIMES_UP = parseSegments(process.env.SEGMENT_TIMES_UP, [18, 18, 17]);   // B->G, G->1, 1->2
const SEGMENT_TIMES_DOWN = parseSegments(process.env.SEGMENT_TIMES_DOWN, [17, 18, 17]); // G->B, 1->G, 2->1
const TRAVEL_MARGIN_S = Number(process.env.TRAVEL_MARGIN_S) || 3; // hard travel limit = expected time + margin
// A board is "silent" when no line came from it for this long. Firmware heartbeat is 5 s today, so keep > 5 s until it is lowered
const BOARD_SILENT_MS = Number(process.env.BOARD_SILENT_MS) || 6000;
const FAULT_CLEAR_MS = Number(process.env.FAULT_CLEAR_MS) || 10000; // silent board must be healthy this long before trips are allowed again
const MAINTENANCE_MINUTES = Number(process.env.MAINTENANCE_MINUTES) || 15;
const DOOR_LOCK_TIMEOUT_MS = Number(process.env.DOOR_LOCK_TIMEOUT_MS) || 3000; // wait for DOOR LOCKED from all levels
const REVERSAL_DEAD_TIME_MS = Number(process.env.REVERSAL_DEAD_TIME_MS) || 300; // pause before reversing direction
const DOOR_ALERT_MS = Number(process.env.DOOR_ALERT_MS) || 10000; // how long a door problem stays on the display
// Overshoot: the lift has no deceleration and coasts past the thin floor line after stopping. A line-lost from the
// floor where the lift stopped, within this window of the stop (before or after), is ignored: the lift stays at that floor
const OVERSHOOT_IGNORE_MS = Number(process.env.OVERSHOOT_IGNORE_MS) || 500;
// Mock mode only: virtual lift coasts this far (m) this long after each stop, 0 = off. Toggle from the mock panel
let mockOvershoot = { m: Number(process.env.MOCK_OVERSHOOT_M) || 0.1, delayMs: Number(process.env.MOCK_OVERSHOOT_DELAY_MS) || 200 };
let travelTimeoutId = null;
let moveSeq = 0; // bumped on every new move or stop, cancels pending door lock waits
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
// const https = require('https');
const http = require('http');

const fs = require('fs');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { createMockBoard, startMockPanel } = require('./mock_panel');

const settings = {
  doors: { auto: true },
  light: { auto: true, timeout: 60, currentState: false },
  callButton: { enabled: true },
  manual: { upEnabled: false, downEnabled: false },
  maintenance: { enabled: false, until: null } // door alerts / lock checks ignored, manual moves only
};

class GpioRelayGroup {
  constructor(id0, id1, label) {
    this.id0 = id0;
    this.id1 = id1;
    this.label = label;
    this.state = 0;
  }
  readSync() {
    return this.state;
  }
  writeSync(state) {
    if (this.state !== state) {
      this.state = state;
      // console.log(`GPIOs #${this.id0} and #${this.id1} ('${this.label}') set to ${this.state? 'ON' : 'OFF'}${mockLiftMode? ' (Virtual)' : ''}`);
      if (!mockLiftMode){
        execSync('gpioset 0 ' + this.id0 + '=' + this.state);
        execSync('gpioset 0 ' + this.id1 + '=' + this.state);
      }
    }
  }
}

// Array to store serial ports and parsers
const ports = [];
const parsers = [];
const levelPack = {};
// Ports tried at startup; any other ttyUSB*/ttyACM* found later is appended (boards can re-enumerate, e.g. ttyUSB3 -> ttyUSB4 after an EMI reset)
const portPaths = [
  '/dev/ttyUSB0',
  '/dev/ttyUSB1',
  '/dev/ttyUSB2',
  '/dev/ttyUSB3'
];
const listOfLevels = ['B', 'G', '1', '2']
let retryTimeouts = new Array(portPaths.length).fill(null); // Now tracks backoff delays too
let retryBackoffs = new Array(portPaths.length).fill(5000); // Initial backoff: 5s per port

// Separate error counters for initial vs. runtime
let initialErrorCount = 0;
let runtimeErrorCount = 0;
const lastDataTimes = portPaths.map(() => Date.now());

// Index of a port path in the per-port arrays, adding it if new
function portIndex(path) {
  let index = portPaths.indexOf(path);
  if (index === -1) {
    index = portPaths.push(path) - 1;
    retryTimeouts[index] = null;
    retryBackoffs[index] = 5000;
    lastDataTimes[index] = Date.now();
  }
  return index;
}

// List serial devices currently present (ttyUSB* / ttyACM*)
async function listSerialPaths() {
  try {
    const list = await SerialPort.list();
    return list.map(p => p.path).filter(p => /^\/dev\/tty(USB|ACM)\d+$/.test(p));
  } catch (err) {
    return fs.readdirSync('/dev').filter(n => /^tty(USB|ACM)\d+$/.test(n)).map(n => '/dev/' + n);
  }
}
    
let currentLevel = 'none';
let currentPosition = 'none';
let displayMessage = 'Idle';
let liftState = 'Idle';
let manual = false;
let clearDisplayMessageTimeout;

// ---- Last known position, kept across reboots ----
// File next to server.js: { floor, viaOvershoot, overshotDir, stale, time }. Written (temp file + rename) when the lift
// is confirmed at a floor, marked stale when a move starts. Loaded at startup only if not stale; a board reporting
// LIFT HERE at startup always wins. Mock mode uses its own file so it never touches the real one.
const positionFile = () => path.join(__dirname, mockLiftMode ? 'last_position.mock.json' : 'last_position.json');
let savedPosition = null; // last content written or loaded

function savePosition(fields) {
  savedPosition = { ...(savedPosition || {}), ...fields, time: new Date().toISOString() };
  const file = positionFile();
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(savedPosition));
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.error(newDateStr(), `Could not save position to ${file}:`, err.message);
  }
}

// Lift confirmed at a floor (arrival, stop at a floor, or overshoot ignored)
function savePositionAtFloor(floor, viaOvershoot = false) {
  if (listOfLevels.includes(floor)) savePosition({ floor, viaOvershoot, overshotDir: null, stale: false });
}

function loadPosition() {
  const file = positionFile();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    savedPosition = data;
    if (data.stale || !listOfLevels.includes(data.floor)) {
      console.warn(newDateStr(), `Saved position ignored (${data.stale ? 'lift moved after it was saved' : 'invalid'}), position unknown until a floor sensor sees the lift`);
      return null;
    }
    console.log(newDateStr(), `Position restored from ${path.basename(file)}: floor ${data.floor}${data.viaOvershoot ? ' (overshoot ignored, sensor may read LIFT AWAY)' : ''}${data.overshotDir === 0 || data.overshotDir === 1 ? ` (had coasted ${data.overshotDir ? 'up' : 'down'} past the line)` : ''} saved ${data.time}`);
    currentLevel = data.floor;
    currentPosition = data.floor;
    if (data.overshotDir === 0 || data.overshotDir === 1) liftOverShot = { levelLabel: data.floor, lastDir: data.overshotDir };
    return data;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(newDateStr(), `Could not read ${file}:`, err.message);
    return null;
  }
}

// ---- Overshoot rule ----
let lastStop = null;     // { level, time } lift stopped at this floor; cleared when a new move starts
let lastLineLost = null; // { level, time } line lost while the motor was running; cleared when a new move starts

// Call when a new move is commanded: line-lost messages from now on are handled normally
function noteMoveStart() {
  lastStop = null;
  lastLineLost = null;
}

// Call when the motor actually starts: the saved floor is no longer trusted until the next confirmed stop
function noteMotorStart() {
  if (!savedPosition || !savedPosition.stale) savePosition({ stale: true });
}

// Lift considered at floor X even though its sensor no longer sees the line
function keepAtFloor(level, why) {
  console.log(newDateStr(), `OVERSHOOT IGNORED at level ${level}: ${why}, lift kept at ${level}`);
  currentLevel = level;
  currentPosition = level;
  liftOverShot = null;
  if (levelPack[level]) levelPack[level].state.presence = 'LIFT HERE';
  savePositionAtFloor(level, true);
}

// Call on every stop, BEFORE the relays are switched off
function noteStop() {
  if (!isMotorOn()) return;
  const now = Date.now();
  const ignored = !!(lastLineLost && now - lastLineLost.time <= OVERSHOOT_IGNORE_MS);
  if (ignored) keepAtFloor(lastLineLost.level, `line lost ${now - lastLineLost.time} ms before the stop`);
  lastLineLost = null;
  if (listOfLevels.includes(currentPosition)) {
    lastStop = { level: currentPosition, time: now };
    if (!ignored) savePositionAtFloor(currentPosition);
  } else lastStop = null;
}

let lightTimeoutId;

function newDateStr(){
  const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}.${month}.${day} ${hours}:${minutes}:${seconds}`
}

function lightSwitch(state){
  if (!mockLiftMode) {
    execSync('gpioset 0 16=' + state);
  } else {
    console.log(newDateStr(), `Mock light set to ${state}`);
  }
}

function setLight(state) {
  if (state !== settings.light.currentState) {
    lightSwitch(state);
    settings.light.currentState = state;
    console.log(newDateStr(), `Light set to ${state ? 'ON' : 'OFF'}`);
  }
  clearTimeout(lightTimeoutId);
  if (state && settings.light.auto && liftState === 'Idle') {
    lightTimeoutId = setTimeout(() => setLight(0), settings.light.timeout * 1000);
  }
}

function clearTravelTimeout() {
  clearTimeout(travelTimeoutId);
  travelTimeoutId = null;
}

// Expected travel time in ms between two positions (meters), from the measured segment times
function expectedTravelMs(fromM, toM) {
  const times = toM > fromM ? SEGMENT_TIMES_UP : SEGMENT_TIMES_DOWN;
  const a = (Math.min(fromM, toM) - levelPositions['B']) / LEVEL_HEIGHT_M;
  const b = (Math.max(fromM, toM) - levelPositions['B']) / LEVEL_HEIGHT_M;
  let ms = 0;
  times.forEach((t, k) => { ms += Math.max(0, Math.min(b, k + 1) - Math.max(a, k)) * t * 1000; });
  return ms;
}

// Numeric position (meters) of currentPosition, mid-segment when between two levels
// Position used for travel-time estimates. Between floors the exact spot is unknown,
// so use the end of the gap farthest from the target (worst case, never stop short).
function currentPositionM(targetM) {
  if (currentPosition.includes('-')) {
    const [a, b] = currentPosition.split(' - ').map(l => levelPositions[l]);
    if (targetM === undefined) return (a + b) / 2;
    return Math.abs(a - targetM) > Math.abs(b - targetM) ? a : b;
  }
  return levelPositions[currentPosition];
}

// Safety cutoff: stop the motor if the move takes longer than expected (ms = expected travel time)
function startTravelTimeout(expectedMs) {
  clearTravelTimeout();
  const ms = Math.round(expectedMs + TRAVEL_MARGIN_S * 1000);
  travelTimeoutId = setTimeout(() => {
    travelTimeoutId = null;
    stopMotion(`Travel timeout (${ms / 1000}s), lift stopped`);
  }, ms);
}

function isMotorOn() {
  return relayUp.readSync() === 1 || relayDown.readSync() === 1;
}

function isMoveActive() {
  return isMotorOn() || liftState === 'Locking doors';
}

// ---- Trip guard: a silent destination board must not strand people in the cabin ----
const levelLastData = {}; // level -> time of last line received from its board
let trip = null;  // active /floor trip: { seq, dir, fromM, startTime, expectedMs, mode: 'normal' | 'stopByTime' | 'allSilent' }
let fault = null; // { levels: [...], reason, since, backSince } blocks new trips until those boards are healthy again

function boardAlive(l) {
  const lp = levelPack[l];
  return !!(lp && lp.port && lp.port.isOpen && Date.now() - (levelLastData[l] || 0) < BOARD_SILENT_MS);
}

function enterFault(levels, reason) {
  const list = fault ? [...new Set([...fault.levels, ...levels])] : levels;
  fault = { levels: list, reason, since: Date.now(), backSince: null };
  console.error(newDateStr(), `FAULT (${list.join(', ')}): ${reason} - new trips blocked until the board(s) are back`);
}

setInterval(() => {
  if (!trip) return;
  if (trip.seq !== moveSeq || !isMotorOn()) { trip = null; return; } // trip ended (arrived, stopped, replaced)
  const elapsed = Date.now() - trip.startTime;
  const dest = targetLevel;
  if (trip.mode !== 'allSilent' && !listOfLevels.some(boardAlive)) {
    trip.mode = 'allSilent';
    console.error(newDateStr(), `ALL level boards silent during trip to ${dest}: will stop by time at expected arrival (${Math.round(trip.expectedMs / 1000)}s). Door locks open on power loss, nothing more possible in software`);
  } else if (trip.mode === 'normal' && listOfLevels.includes(dest) && !boardAlive(dest)) {
    const step = trip.dir ? 1 : -1;
    let i = listOfLevels.indexOf(dest) + step;
    while (i >= 0 && i < listOfLevels.length && !boardAlive(listOfLevels[i])) i += step;
    if (i >= 0 && i < listOfLevels.length) {
      const next = listOfLevels[i];
      enterFault([dest], `board ${dest} silent during trip, continuing to ${next}`);
      targetLevel = next;
      trip.expectedMs = expectedTravelMs(trip.fromM, levelPositions[next]);
      displayMessage = `Level ${dest} not responding, going to ${next}`;
    } else {
      trip.mode = 'stopByTime';
      enterFault([dest], `board ${dest} silent during trip, end floor: stopping by time (${Math.round(trip.expectedMs / 1000)}s)`);
      displayMessage = `Level ${dest} not responding, stopping by time`;
    }
  }
  if (trip.mode !== 'normal' && elapsed >= trip.expectedMs) {
    const allSilent = trip.mode === 'allSilent';
    trip = null;
    stopMotion(`Stopped by time at ${dest} (${allSilent ? 'all boards silent' : 'board ' + dest + ' silent'})`);
    sendToLevel(dest, 'UNLOCK_DOOR');
    if (allSilent) enterFault(listOfLevels.slice(), 'all level boards silent, lift stopped by time');
  } else if (elapsed >= trip.expectedMs + TRAVEL_MARGIN_S * 1000) {
    trip = null;
    stopMotion(`Travel limit (${Math.round(elapsed / 1000)}s) reached before ${dest}, lift stopped`);
  }
}, 200);

// Clear the fault once every faulty board has been sending data again for FAULT_CLEAR_MS
setInterval(() => {
  if (!fault) return;
  if (fault.levels.every(boardAlive)) {
    if (!fault.backSince) fault.backSince = Date.now();
    else if (Date.now() - fault.backSince >= FAULT_CLEAR_MS) {
      console.log(newDateStr(), `FAULT cleared: board(s) ${fault.levels.join(', ')} healthy again, trips allowed`);
      fault = null;
    }
  } else fault.backSince = null;
}, 1000);

// Maintenance mode: door-open alerts and door-lock checks ignored, only manual moves, auto-expires
let maintenanceTimeoutId = null;
function setMaintenance(enabled, why) {
  clearTimeout(maintenanceTimeoutId);
  settings.maintenance.enabled = !!enabled;
  settings.maintenance.until = enabled ? Date.now() + MAINTENANCE_MINUTES * 60000 : null;
  if (enabled) maintenanceTimeoutId = setTimeout(() => setMaintenance(false, 'expired'), MAINTENANCE_MINUTES * 60000);
  console.warn(newDateStr(), `MAINTENANCE MODE ${enabled ? 'ENABLED for ' + MAINTENANCE_MINUTES + ' min' : 'DISABLED'} (${why})`);
}

// Stop the motor and reset move state, with a message for the display
function stopMotion(reason, holdMs = 5000) {
  moveSeq++;
  clearTravelTimeout();
  noteStop();
  relayUp.writeSync(0);
  relayDown.writeSync(0);
  if (mockLiftMode) mockLiftUpdate(false);
  liftState = 'Idle';
  initiatedByButton = false;
  manual = false;
  targetLevel = null;
  settings.manual.upEnabled = false;
  settings.manual.downEnabled = false;
  console.error(newDateStr(), 'STOP:', reason);
  displayMessage = reason;
  clearTimeout(clearDisplayMessageTimeout);
  clearDisplayMessageTimeout = setTimeout(() => {
    displayMessage = liftState;
  }, holdMs);
}

function sendToLevel(levelLabel, cmd) {
  const level = levelPack[levelLabel];
  if (!level || !level.port) return;
  level.port.write(cmd + '\r\n', (err) => {
    if (err) return console.error(newDateStr(), `Error writing ${cmd} to ${levelLabel}:`, err.message);
    console.log(newDateStr(), `message sent to ${levelLabel} (${level.port.settings ? level.port.settings.path : 'Mock'}) : ${cmd}`);
  });
}

// Abort a move that could not start: stop, and unlock the door where the lift stands
function abortMove(reason, holdMs) {
  stopMotion(reason, holdMs);
  if (listOfLevels.includes(currentPosition)) sendToLevel(currentPosition, 'UNLOCK_DOOR');
}

// Send LOCK_DOOR to every connected level and call onLocked once all report DOOR LOCKED
function lockAllDoorsThen(seq, onLocked, onFail) {
  if (settings.maintenance.enabled) {
    console.warn(newDateStr(), 'Maintenance mode: door lock check skipped');
    return onLocked();
  }
  const connected = Object.keys(levelPack).filter(l => levelPack[l].port && levelPack[l].port.isOpen);
  if (connected.length === 0) return onFail('No level module connected, move refused');
  connected.forEach(l => {
    levelPack[l].state.doorLocked = false; // wait for a fresh confirmation
    levelPack[l].state.lockRefused = false;
    sendToLevel(l, 'LOCK_DOOR');
  });
  const start = Date.now();
  const st = l => (levelPack[l] ? levelPack[l].state : {});
  const poll = setInterval(() => {
    if (seq !== moveSeq) return clearInterval(poll); // move cancelled or replaced
    const refused = connected.filter(l => st(l).lockRefused && st(l).doorClosed === false);
    if (connected.every(l => st(l).doorLocked)) {
      clearInterval(poll);
      onLocked();
    } else if (refused.length) {
      // Board answered CAN'T LOCK DOOR with door_closed = false: no point waiting
      clearInterval(poll);
      onFail(`Door open at floor ${refused.join(', ')}, lift not moving`, DOOR_ALERT_MS);
    } else if (Date.now() - start > DOOR_LOCK_TIMEOUT_MS) {
      clearInterval(poll);
      const notLocked = connected.filter(l => !st(l).doorLocked);
      const open = notLocked.filter(l => st(l).doorClosed === false);
      onFail(open.length ? `Door open at floor ${open.join(', ')}, lift not moving` : `Door not locked at floor ${notLocked.join(', ')}, lift not moving`, DOOR_ALERT_MS);
    }
  }, 50);
}

// Function to parse serial data and determine the level
function parseLevelData(data, port=null) {
  const parts = data.split(' : ');
  const levelLabel = parts[0];
  if (listOfLevels.includes(levelLabel)) levelLastData[levelLabel] = Date.now();
  // Keep levelPack pointing at the port this level currently talks on (fixes stale port after reconnect)
  if (port && listOfLevels.includes(levelLabel)) {
    if (!levelPack[levelLabel]) {
      levelPack[levelLabel] = { port, state: { presence: null, doorClosed: true, doorLocked: false } };
    } else if (levelPack[levelLabel].port !== port) {
      const oldPort = levelPack[levelLabel].port;
      if (oldPort && oldPort.isOpen) console.warn(newDateStr(), `WARNING: level ${levelLabel} claimed by both ${oldPort.settings.path} and ${port.settings.path}, keeping newest (${port.settings.path})`);
      console.log(newDateStr(), `level ${levelLabel} now on port ${port.settings.path}`);
      levelPack[levelLabel].port = port;
    }
  }
  if (parts.length === 2) {
    const message = parts[1];
    if (message === 'LIFT HERE') {
      liftOverShot=null;
      if (!isMotorOn()) savePositionAtFloor(levelLabel); // idle and on the line: confirmed position
      console.log(newDateStr(),'lift here', levelLabel)
      currentLevel = levelLabel;
      currentPosition = levelLabel;
      levelPack[levelLabel].state.presence = 'LIFT HERE';
      if (targetLevel === currentLevel || (currentLevel === 'B' && liftState != 'Going UP') || (currentLevel === '2' && liftState != 'Going DOWN')) {
        //displayMessage = `Level ${currentLevel} Reached`;
        clearTimeout(clearDisplayMessageTimeout);
        clearDisplayMessageTimeout = setTimeout(() => {
          displayMessage = liftState;
        }, 2000);
	      if (targetLevel === currentLevel){
          console.log(newDateStr(),
            `PRESENCE SENSOR TRIGGERED > Lift stopped at target level: ${targetLevel}`
          );
          try {
            if (levelPack[levelLabel]) {
              const level = levelPack[levelLabel];
              level.port.write('UNLOCK_DOOR\r\n',function(err){
                if (err) {return console.error("error on write", err.message)}
                const portPath = level.port && level.port.settings ? level.port.settings.path : 'Mock';
                console.log(newDateStr(),"message sent to "+ currentLevel + " (" + portPath + ") : UNLOCK_DOOR")
              })
            }
          } catch (error) {
            console.error(newDateStr(), 'Error unlocking door:', error);
          }
        } else console.log(newDateStr(),
          `PRESENCE SENSOR TRIGGERED > Lift stopped at limit: ${currentLevel}`
        );
        moveSeq++;
        clearTravelTimeout();
        noteStop();
        relayUp.writeSync(0);
        relayDown.writeSync(0);
        if (mockLiftMode) mockCoast();
        if (manual) {
          if (lastDir === 1) {
            settings.manual.upEnabled = false;
          } else if (lastDir === 0) {
            settings.manual.downEnabled = false;
          }
        }
        liftState = 'Idle';
        initiatedByButton = false;
        manual = false;
        targetLevel = null;
        clearInterval(virtualLiftMoveInterval);
        virtualLiftMoveInterval = null;
        virtualLiftMovingDirection = null;
        targetLevel = null;
        if (settings.light.currentState && settings.light.auto) {
          clearTimeout(lightTimeoutId);
          lightTimeoutId = setTimeout(() => setLight(0), settings.light.timeout * 1000);
        }
      } else {
        console.log(newDateStr(),`PRESENCE SENSOR TRIGGERED > Lift reached level: ${currentLevel}`);
      }
    } else if (message === 'LIFT AWAY') {
      const sinceStop = lastStop && lastStop.level === levelLabel ? Date.now() - lastStop.time : Infinity;
      if (!isMotorOn() && sinceStop <= OVERSHOOT_IGNORE_MS) {
        // Lift coasted past the line after stopping here: still at this floor
        lastStop = null;
        keepAtFloor(levelLabel, `line lost ${sinceStop} ms after the stop`);
        return;
      }
      levelPack[levelLabel].state.presence = null;
      console.log(newDateStr(),`PRESENCE SENSOR TRIGGERED > Lift left level ${levelLabel}`);
      if (isMotorOn()) lastLineLost = { level: levelLabel, time: Date.now() };
      if (relayUp.readSync()) {
        const nextLevelIdx = listOfLevels.indexOf(levelLabel) + 1
        const nextLevel = listOfLevels[nextLevelIdx]
        currentPosition = `${currentLevel} - ${nextLevel}`
      }
      else if (relayDown.readSync()) {
        const nextLevelIdx = listOfLevels.indexOf(levelLabel) - 1
        const nextLevel = listOfLevels[nextLevelIdx]
        currentPosition = `${nextLevel} - ${currentLevel}`
      }
      else if (levelLabel === currentPosition) { // a line-lost from a floor the lift is not at means nothing
        console.log(newDateStr(),`LIFT OVERSHOT @ level ${levelLabel} while going ${lastDir?"UP":"DOWN"}`);
        liftOverShot = {levelLabel,lastDir}
        savePosition({ floor: levelLabel, viaOvershoot: false, overshotDir: lastDir, stale: false });
      }
    } else if (message === 'DOOR OPEN') {
      levelPack[levelLabel].state.doorClosed = false;
      if (settings.maintenance.enabled) console.warn(newDateStr(), `Maintenance mode: door open at level ${levelLabel} ignored`);
      else if (liftState === 'Locking doors') abortMove(`Door open at floor ${levelLabel}, lift not moving`, DOOR_ALERT_MS);
      else if (isMotorOn()) stopMotion(`Door open at floor ${levelLabel}, lift stopped`, DOOR_ALERT_MS);
      if (settings.light.auto) {
        // setLight(1);
      }
    } else if (message === 'DOOR CLOSED') {
      levelPack[levelLabel].state.doorClosed = true;
      if (settings.doors.auto && levelPack[levelLabel].state.presence !== 'LIFT HERE') {
        levelPack[levelLabel].port.write('LOCK_DOOR\r\n', (err) => {
          if (err) console.error(newDateStr(), 'Error writing LOCK_DOOR:', err);
        });
      }
    } else if (message === 'DOOR LOCKED') {
      levelPack[levelLabel].state.doorLocked = true;
    } else if (message === 'DOOR UNLOCKED') {
      levelPack[levelLabel].state.doorLocked = false;
    } else if (message === "CAN'T LOCK DOOR") {
      // Followed by door_lock_requested / door_closed lines; only a refused request with the door open aborts a move
      if (levelPack[levelLabel]) levelPack[levelLabel].state.lockRefused = true;
    } else if (message.startsWith('door_lock_requested = ')) {
      if (levelPack[levelLabel] && message.endsWith('false')) levelPack[levelLabel].state.lockRefused = false;
    } else if (message.startsWith('door_closed = ')) {
      if (levelPack[levelLabel]) levelPack[levelLabel].state.doorClosed = message.endsWith('true');
      if (levelPack[levelLabel] && levelPack[levelLabel].state.lockRefused && message.endsWith('false'))
        console.warn(newDateStr(), `Level ${levelLabel} can't lock its door: door open`);
    } else if (message === 'call_button_pressed'){
      if (settings.callButton.enabled) {
        console.log(newDateStr(), `Call button pressed at ${levelLabel}`);
        if (liftState === 'Idle') {
          goToFloor(levelLabel);
          // if (settings.light.auto) setLight(1);
        } else {
          console.log(newDateStr(), 'Lift busy, ignoring call');
        }
      }
    } else if (message === '<3') {
      // Silent: No log to avoid flooding
    } else {
      console.log(newDateStr(), `Unknown message from ${levelLabel}: ${message}`);
    }
  } else if (parts.length === 3){
    if (parts[1] === 'ALERT' && parts[2] === 'DOOR OPEN WHILE LOCKED') {
      console.error(newDateStr(), `ALERT from level ${levelLabel}: DOOR OPEN WHILE LOCKED`);
      if (levelPack[levelLabel]) {
        levelPack[levelLabel].state.doorClosed = false;
        levelPack[levelLabel].state.doorLocked = false;
      }
      if (settings.maintenance.enabled) console.warn(newDateStr(), `Maintenance mode: door forced open alert at level ${levelLabel} ignored`);
      else if (liftState === 'Locking doors') abortMove(`Door forced open at floor ${levelLabel}, lift not moving`, DOOR_ALERT_MS);
      else if (isMotorOn()) stopMotion(`Door forced open at floor ${levelLabel}, lift stopped`, DOOR_ALERT_MS);
    }
    // console.log('parts == 3')
    // console.log(parts)
    
    if (parts[1].startsWith("initial door_sensor")){
      console.log(newDateStr(),'port', port.settings.path,"identified as level", parts[0])
      const doorClosed = parts[2]=='DOOR CLOSED'
      if (!levelPack[parts[0]]) levelPack[parts[0]] = { port, state: { doorClosed, presence: null, doorLocked: true } };
      else levelPack[parts[0]].state.doorClosed=doorClosed
    } else if (parts[1].startsWith("initial lift_sensor")){
      console.log(newDateStr(),'port', port.settings.path,"identified as level", parts[0])
      const here = parts[2]=='LIFT HERE'
      if (here) {
        currentPosition = parts[0]
        currentLevel = parts[0]
        liftOverShot = null
        savePositionAtFloor(parts[0])
      }
      if (!levelPack[parts[0]]) levelPack[parts[0]] = { port, state: { presence: here ? 'LIFT HERE' : null, doorClosed: true, doorLocked: true } };
      else levelPack[parts[0]].state.presence = here ? 'LIFT HERE' : null
    } 
  }
}


function createMockSerialDataGenerator(portPath) {
  console.log(newDateStr(),`Creating mock data generator for ${portPath}`);
}

function updateMockLevelData() {
  if (!mockLiftMode) return; // never feed virtual readings into real mode
  const tolerance = positionTolerance;
  for (const level in levelPositions) {
    const levelPosition = levelPositions[level];
    const positionDiff = Math.abs(virtualLiftPosition - levelPosition);
 
    const levelStatus = (positionDiff <= tolerance)? 'LIFT HERE' : 'LIFT AWAY';
    const mockLevelData = `${level} : ${levelStatus}`;
    if (mockBoards[level] && mockBoards[level].silent) continue; // silenced board sends nothing
    if(!mockLevelObject.hasOwnProperty(level) || mockLevelObject[level] != mockLevelData) {
      mockLevelObject[level] = mockLevelData;
      // console.log(`Mock data update: ${mockLevelData}`);
      parseLevelData(mockLevelData);
    }
  }
}

// Function to close all ports gracefully (new: for shutdown)
function closeAllPorts() {
  ports.forEach((port, index) => {
    if (port && port.isOpen) {
      console.log(newDateStr(), `Closing port ${portPaths[index]}`);
      port.close();
    }
  });
  retryTimeouts.forEach(timeout => {
    if (timeout) clearTimeout(timeout);
  });
  retryTimeouts.fill(null);
}

// Function to open or reopen a serial port (enhanced with exponential backoff and better duplicate prevention)
function openSerialPort(path, index, isInitial = false) {
  if (mockLiftMode) return; // Skip in mock mode
  // Enhanced duplicate prevention: Check if port exists, is open, or retry pending
  if (ports[index] && (ports[index].isOpen || retryTimeouts[index])) {
    console.log(newDateStr(), `Port ${path} already open or retry pending, skipping.`);
    return;
  }

  console.log(newDateStr(), `Attempting to open serial port: ${path} (initial: ${isInitial}, backoff: ${retryBackoffs[index]/1000}s)`);
  // Discard any dead SerialPort object left from a previous connection before creating a fresh one
  if (ports[index]) {
    ports[index].removeAllListeners();
    ports[index].on('error', () => {}); // swallow late errors from the dead object
    if (!ports[index].destroyed) ports[index].destroy();
    ports[index] = null;
  }
  lastDataTimes[index] = Date.now(); // fresh heartbeat window for the new attempt
  const port = new SerialPort({ path: path, baudRate: 9600 });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  ports[index] = port;
  parsers[index] = parser;

  port.on('open', () => {
    console.log(`${newDateStr()} PORT OPEN ${path}`);
    // Reset backoff and heartbeat on successful open
    retryBackoffs[index] = 5000; // Reset to initial
    if (retryTimeouts[index]) {
      clearTimeout(retryTimeouts[index]);
      retryTimeouts[index] = null;
      console.log(newDateStr(), `Cancelled pending retry for ${path}`);
    }
    lastDataTimes[index] = Date.now();
  });

  parser.on('data', data => {
    if (!data.trim().endsWith(' : <3')) console.log(newDateStr(), `${path} : ${data}`);
    parseLevelData(data, port);
    lastDataTimes[index] = Date.now(); // Update heartbeat
  });

  port.on('error', err => {
    if (mockLiftMode) return; // Skip error handling in mock
    const errorType = isInitial ? 'initial' : 'runtime';
    console.error(newDateStr(), `Serial port ${errorType} error for ${path}: ${err.message}`);
    
    // Increment appropriate counter
    if (errorType === 'initial') initialErrorCount++;
    else runtimeErrorCount++;

    // Cancel pending retry on error
    if (retryTimeouts[index]) {
      clearTimeout(retryTimeouts[index]);
      retryTimeouts[index] = null;
    }
    
    if (isInitial) {
      createMockSerialDataGenerator(path);
      if (initialErrorCount >= 4) {
        mockLiftMode = true;
        console.error(newDateStr(), 'Mock Lift Mode Activated due to initial errors');
        // Initialize levelPack for mock
        // Virtual boards answer LOCK_DOOR/UNLOCK_DOOR like the firmware; their lines go through parseLevelData like serial data
        listOfLevels.forEach(level => {
          mockBoards[level] = createMockBoard(level, line => {
            if (!line.endsWith(' : <3')) console.log(newDateStr(), `Mock_${level} : ${line}`);
            parseLevelData(line);
          });
          levelPack[level] = {
            port: mockBoards[level].port,
            state: { presence: null, doorClosed: true, doorLocked: true }
          };
        });
        startMockPanel(Number(process.env.MOCK_PANEL_PORT) || 9700, mockBoards, () => ({
          overshoot: mockOvershoot.m ? `${mockOvershoot.m} m after ${mockOvershoot.delayMs} ms (ignore window ${OVERSHOOT_IGNORE_MS} ms)` : 'off',
          fault, maintenance: settings.maintenance, liftState, currentPosition, targetLevel, displayMessage, light: settings.light.currentState ? 1 : 0,
          presence: Object.fromEntries(listOfLevels.map(l => [l, levelPack[l] && levelPack[l].state.presence === 'LIFT HERE']))
        }), act => { // panel-wide actions
          if (act !== 'overshoot') return 'unknown action';
          // cycle: inside the ignore window, outside it (handled as a real overshoot), off
          const steps = [{ m: 0.1, delayMs: 200 }, { m: 0.1, delayMs: OVERSHOOT_IGNORE_MS + 300 }, { m: 0, delayMs: 200 }];
          const i = steps.findIndex(x => x.m === mockOvershoot.m && x.delayMs === mockOvershoot.delayMs);
          mockOvershoot = steps[(i + 1) % steps.length];
          console.log(newDateStr(), `Mock overshoot: ${mockOvershoot.m ? mockOvershoot.m + ' m after ' + mockOvershoot.delayMs + ' ms' : 'off'}`);
          return null;
        });
        // Start where the last mock run left the lift (last_position.mock.json), G otherwise
        currentLevel = 'none';
        currentPosition = 'none';
        liftOverShot = null;
        savedPosition = null;
        const saved = loadPosition();
        const startFloor = saved ? saved.floor : 'G';
        currentLevel = startFloor;
        currentPosition = startFloor;
        virtualLiftPosition = levelPositions[startFloor];
        const coasted = saved && (saved.viaOvershoot || saved.overshotDir === 0 || saved.overshotDir === 1);
        if (coasted) {
          // it had coasted past the line: the virtual sensor reads LIFT AWAY, as on the real lift.
          // Seed the virtual reading so that startup line-lost is not taken as a new event
          const dir = saved.overshotDir === 0 ? 0 : 1;
          virtualLiftPosition += (dir === 1 ? 1 : -1) * (mockOvershoot.m || 0.1);
          mockLevelObject[startFloor] = `${startFloor} : LIFT AWAY`;
        }
        if (!coasted || saved.viaOvershoot) levelPack[startFloor].state.presence = 'LIFT HERE';
        updateMockLevelData();
      }
    } else if (runtimeErrorCount >= 2) { // Threshold for runtime errors to trigger mock if persists
      console.warn(newDateStr(), 'High runtime errors; consider mock mode if persists');
    }
    
    if (port.isOpen) port.close(); // Only close if open, to avoid extra errors
  });

  port.on('close', () => {
    const dateTimeStr = newDateStr();
    console.error(`${dateTimeStr} Serial port closed for ${path} (backoff will be ${retryBackoffs[index]/1000}s)`);
    // During a /floor trip keep going: the trip guard diverts to the next live floor or stops by time
    if (trip && trip.seq === moveSeq && isMotorOn()) console.error(newDateStr(), `Serial link lost (${path}) during trip, trip guard takes over`);
    else if (isMoveActive()) stopMotion(`Serial link lost (${path}), lift stopped`);
    // Drop level mappings on this port so the level can be picked up again on whatever port it reappears
    Object.keys(levelPack).forEach(l => {
      if (levelPack[l].port === port) {
        console.log(newDateStr(), `level ${l} unmapped from ${path}`);
        delete levelPack[l];
      }
    });
    // Clear any existing timeout first
    if (retryTimeouts[index]) {
      clearTimeout(retryTimeouts[index]);
      retryTimeouts[index] = null;
    }
    // Set exponential backoff timeout only if not in mock mode
    if (!mockLiftMode && fs.existsSync(path)) {
      const delay = retryBackoffs[index];
      retryTimeouts[index] = setTimeout(() => {
        retryTimeouts[index] = null; // Clear after firing
        if (fs.existsSync(path)) openSerialPort(path, index, false);
        // Double backoff for next time (cap at 60s)
        retryBackoffs[index] = Math.min(retryBackoffs[index] * 2, 60000);
      }, delay);
    }
  });
}

console.log(newDateStr(),'--------------------');
console.log(newDateStr(),'STARTING LIFT SERVER');
console.log(newDateStr(),'--------------------');

loadPosition(); // last known floor from before the restart; a board reporting LIFT HERE overrides it

// Initialize serial ports
portPaths.forEach((path, index) => {
  openSerialPort(path, index, true);
});

// Periodic heartbeat check (tweaked: 20s threshold, check every 5s for faster response)
setInterval(() => {
  if (mockLiftMode) return; // Skip in mock mode
  portPaths.forEach((path, index) => {
    if (ports[index] && ports[index].isOpen && Date.now() - lastDataTimes[index] > 20000) { // 20s threshold
      console.error(newDateStr(), `Stale heartbeat for ${path} (>20s), forcing reconnect`);
      runtimeErrorCount++; // Count as runtime error
      if (ports[index] && ports[index].isOpen) {
        if (retryTimeouts[index]) {
          clearTimeout(retryTimeouts[index]);
          retryTimeouts[index] = null;
        }
        const stalePort = ports[index];
        stalePort.close(err => {
          // If close fails (device already gone) force-destroy so the scan can reopen with a fresh object
          if (err) {
            console.error(newDateStr(), `Close failed for ${path}: ${err.message}, destroying port`);
            stalePort.destroy();
            stalePort.emit('close');
          }
        });
      }
    }
  });
}, 5000); // Check every 5s

// Every 5s, open any serial port that appeared (e.g. a board re-enumerated on a new ttyUSB number)
let scanning = false;
setInterval(async () => {
  if (mockLiftMode || scanning) return;
  scanning = true;
  try {
    const present = await listSerialPaths();
    present.forEach(path => {
      const index = portIndex(path);
      if (!(ports[index] && ports[index].isOpen) && !retryTimeouts[index]) openSerialPort(path, index, false);
    });
    // Close ports whose device vanished
    portPaths.forEach((path, index) => {
      if (!present.includes(path) && ports[index] && ports[index].isOpen) {
        console.error(newDateStr(), `Serial device ${path} disappeared, closing`);
        ports[index].close();
      }
    });
  } catch (err) {
    console.error(newDateStr(), 'Serial port scan failed:', err.message);
  } finally {
    scanning = false;
  }
}, 5000);

const app = express();

app.use((req, res, next) => {
  if (!['/status','/heartbeat'].includes(req.url))
  console.log(newDateStr(),'REQURL :',new Date(),req.url);
  next();
});
app.use(cookieParser());
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));
const PORT = process.env.PORT || 5000;


// JWT secret keys
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET;
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET;

// User credentials from environment variables
const user = {
  username: process.env.USERNAME,
  password: bcrypt.hashSync(process.env.PASSWORD, 10)
};

// Set up GPIO pins for relays (adjust pin numbers as needed)
let relayUp, relayDown;
try {

relayDown = new GpioRelayGroup(12, 24, 'DOWN');
relayUp = new GpioRelayGroup(23, 24, 'UP');

} catch (error) {
  relayDown = false;
  relayUp = false;
  console.error(newDateStr(),'Error initializing GPIO:', error);
  process.exit(1);
}

app.use(express.static(path.join(__dirname, 'client/build')));
app.use(express.json());

// let lastHeartbeat = Date.now();
// const HEARTBEAT_INTERVAL = 1000; // 1 second
// const INACTIVE_THRESHOLD = 60000; // 10 seconds

// Function to turn off both relay groups
function turnOffRelays() {
  try {
    if (relayDown.readSync()===0 && relayUp.readSync()===0) return
    relayUp.writeSync(0);
    relayDown.writeSync(0);
    console.log(newDateStr(),'Both relays turned off due to inactivity');
  } catch (error) {
    console.error(newDateStr(),'Error turning off relays:', error);
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Middleware to verify JWT
const verifyToken = (req, res, next) => {
  // Skip all auth checks if DISABLE_AUTH is set
  if (process.env.DISABLE_AUTH === 'true') {
    // UPDATED: Removed spammy console.log - logs once on startup instead
    return next();
  }

  const accessToken = req.cookies.accessToken;
  const refreshToken = req.cookies.refreshToken;
  
  // 1. Skip token verification for static files and resources
  if (req.url.startsWith('/static/') || 
      req.url === '/favicon.ico' || 
      req.url === '/manifest.json') {
    return next();
  }
  
  // 2. Endpoints that need special handling
  if (req.url === '/login') {
    return next(); // Always allow login attempts
  }
  
  // 3. Endpoints that can work with or without tokens
  if (req.url === '/check-auth') {
    if (!accessToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // If token exists, continue to verification below
  }
  
  // 4. Refresh token endpoint needs the refresh token
  if (req.url === '/refresh-token') {
    if (!refreshToken) {
      console.log(newDateStr(),'Refresh token required');
      return res.status(401).json({ error: 'Refresh token required' });
    }
    return next(); // Let the endpoint handle refresh token verification
  }
  
  // 5. For all other endpoints, verify the access token
  if (!accessToken) {
    console.log(newDateStr(),'Access token required');
    return res.status(403).json({ error: 'Access token required' });
  }

  jwt.verify(accessToken, accessTokenSecret, (err, decoded) => {
    if (err) {
      console.log(newDateStr(),'Access token invalid');
      return res.status(403).json({ error: 'Invalid access token' });
    }
    req.user = decoded;
    next();
  });
};

// Log auth disable once on startup (replaces per-request spam)
if (process.env.DISABLE_AUTH === 'true') {
  console.log(newDateStr(), 'Auth disabled - bypassing token verification for all requests');
}

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  console.log(newDateStr(),'Login attempt for user:', req.body.username);
  // In a real application, you would validate against a database
  if (username === user.username && bcrypt.compareSync(password, user.password)) {
    // Generate tokens
    const accessToken = jwt.sign({ username: user.username }, accessTokenSecret, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ username: user.username }, refreshTokenSecret, { expiresIn: '7d' });
    
    displayMessage = "You're in!";
    clearTimeout(clearDisplayMessageTimeout);
    clearDisplayMessageTimeout = setTimeout(() => {
      displayMessage = liftState;
    }, 2000);

    // Set tokens as HttpOnly cookies
    res.cookie('accessToken', accessToken, { httpOnly: true, sameSite: 'Lax' });
    res.cookie('refreshToken', refreshToken, { httpOnly: true, sameSite: 'Lax' });

    console.log(newDateStr(),'Login success for user', req.body.username);
    // console.log('accessToken', accessToken);
    // console.log('refreshToken', refreshToken);
    return res.status(200).json({ message: 'Login successful' });
  } else {
    console.log('User not found:', req.body.username);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
});

app.post('/refresh-token', (req, res) => {
  // console.log()
  // console.log()
  // console.log(levelPack)
  // console.log()
  
  const moduleCount = Object.keys(levelPack).length
  let all_closed = false
  for (levelLabel in levelPack){
    const level = levelPack[levelLabel]
    console.log(newDateStr(),">>> " + levelLabel + " " + level.state.doorClosed?"door closed":"door open")
    if(level.state.doorClosed && !level.state.presence) {
      level.port.write('LOCK_DOOR\r\n',(err)=>{
        if (err) return console.error("error on write", err.message)
        console.log(newDateStr(),"message sent to (" + (level && level.port && level.port.settings ? level.port.settings.path : 'Mock') + ") : LOCK_DOOR")
      })
    }
  }


  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) {
    console.log(newDateStr(),'Refresh token required')
    return res.status(401).json({ error: 'Refresh token required' });
  }

  jwt.verify(refreshToken, refreshTokenSecret, (err, decoded) => {
    if (err) {
      console.log(newDateStr(),'Invalid refresh token')
      return res.status(403).json({ error: 'Invalid refresh token' });
    }

    // In real application, you should check if the refresh token is still valid in database

    const accessToken = jwt.sign({ username: decoded.username }, accessTokenSecret, { expiresIn: '15m' });
    res.cookie('accessToken', accessToken, { httpOnly: true, sameSite: 'Lax' });
    console.log(newDateStr(),'Access token refreshed')
    return res.status(200).json({ message: 'Access token refreshed' });
    });
});

app.get('/check-auth', verifyToken, (req, res) => { // Added /check-auth endpoint
  console.log(newDateStr(),'Authenticated')
  if (settings.light.auto) setLight(1);
  res.status(200).json({ 
    message: 'Authenticated', 
    authDisabled: process.env.DISABLE_AUTH === 'true' 
  }); // NEW: Include authDisabled flag
});

app.post('/logout', verifyToken, (req, res) => {
  // Clear access and refresh tokens by setting empty cookies with immediate expiry
  res.cookie('accessToken', '', { httpOnly: true, sameSite: 'Lax', expires: new Date(0) });
  res.cookie('refreshToken', '', { httpOnly: true, sameSite: 'Lax', expires: new Date(0) });
  return res.status(200).json({ message: 'Logout successful' });
});

app.get('/status', verifyToken, (req, res) => {
  try {
    // lightSwitch(1) // Remove this, as it's not needed
    // const currentLevelsDisplay = {}
    // console.log(currentLevels)
    // listOfLevels.forEach(level=>{currentLevelsDisplay[level]=(level==currentLevel)? 'LIFT HERE' : 'LIFT AWAY'})
    let resObj = {
      up: relayUp.readSync(),
      down: relayDown.readSync(),
      currentPosition,
      targetLevel,
      displayMessage,
      manual,
      settings,
      fault: fault ? { levels: fault.levels, reason: fault.reason, since: fault.since } : null,
      boards: Object.fromEntries(listOfLevels.map(l => [l, boardAlive(l)])),
      doorStatuses: {
        allOpen: Object.values(levelPack).every(l => !l.state.doorLocked),
        allLocked: Object.values(levelPack).every(l => l.state.doorLocked)
      }
    };
    res.json(resObj);
    // console.log('status out')
    // console.log(resObj);
    // if (resObj.up || resObj.down) console.error('resObj : ', resObj);
  } catch (error) {
    console.error(newDateStr(),'Error reading GPIO status:', error);
    res.status(500).json({ error: 'Error reading lift status' });
  }
});

let virtualLiftMovingDirection = null; // Added missing declaration

let mockMovingDir = null; // direction of the running virtual lift, used for the coast after a stop
let mockCoastTimeout = null;

// Mock mode: the virtual lift coasts past the line after a stop, like the real one (no deceleration)
function mockCoast() {
  clearInterval(virtualLiftMoveInterval);
  virtualLiftMoveInterval = null;
  const dir = mockMovingDir;
  mockMovingDir = null;
  if (dir === null || !mockOvershoot.m) return;
  clearTimeout(mockCoastTimeout);
  mockCoastTimeout = setTimeout(() => {
    if (virtualLiftMoveInterval) return; // a new move started meanwhile
    virtualLiftPosition += dir === 1 ? mockOvershoot.m : -mockOvershoot.m;
    console.log(newDateStr(), `Virtual lift coasted ${mockOvershoot.m} m ${dir === 1 ? 'up' : 'down'} ${mockOvershoot.delayMs} ms after the stop: ${virtualLiftPosition.toFixed(2)}`);
    updateMockLevelData();
  }, mockOvershoot.delayMs);
}

function mockLiftUpdate(state, direction){
  if (state) {
    clearTimeout(mockCoastTimeout);
    mockMovingDir = direction === 1 ? 1 : 0;
    if (!virtualLiftMoveInterval) { // Prevent multiple intervals
      virtualLiftMoveInterval = setInterval(() => {
        const step = (direction === 1)? 0.02 : -0.02;
        virtualLiftPosition += step;

        // Basic boundary checks (can be refined)
        virtualLiftPosition = Math.max(-3, Math.min(6, virtualLiftPosition)); // Limit to [-3, 6] range
        console.log(newDateStr(),`Virtual lift position updated: ${virtualLiftPosition}`);
        updateMockLevelData(); // Update mock levels based on new position

        
      }, 100); // Interval for movement simulation (adjust as needed)
    }
  } else {
    mockCoast();
    updateMockLevelData(); // Update mock levels when lift stops
  }
}
function goToFloor(newTargetLevel){
  const blocked = tripBlockedReason();
  if (blocked) {
    console.warn(newDateStr(), `Trip to ${newTargetLevel} refused: ${blocked}`);
    displayMessage = blocked;
    return false;
  }
  targetLevel = newTargetLevel;
  displayMessage = `Level ${newTargetLevel} Requested`;
  clearTimeout(clearDisplayMessageTimeout);
  clearDisplayMessageTimeout = setTimeout(() => {
    displayMessage = liftState;
  }, 2000);
  console.log(newDateStr(),`Lift target level updated to: ${targetLevel}`);
  if (liftOverShot){
    if (liftOverShot.lastDir) {
      const nextLevelIdx = listOfLevels.indexOf(liftOverShot.levelLabel) + 1
      const nextLevel = listOfLevels[nextLevelIdx]
      currentPosition = `${currentLevel} - ${nextLevel}`
    }
    else {
      const nextLevelIdx = listOfLevels.indexOf(liftOverShot.levelLabel) - 1
      const nextLevel = listOfLevels[nextLevelIdx]
      currentPosition = `${nextLevel} - ${currentLevel}`
    }
    liftOverShot=null
  }
  if (currentPosition != targetLevel) {
    let numPosition;
    if (currentPosition.includes('-'))
      numPosition = levelPositions[currentPosition.split(' - ')[0]] + 1.5;
    else numPosition = levelPositions[currentPosition];
    // console.log('numPosition : ', numPosition);
    const heightDiff = levelPositions[targetLevel] - numPosition;
    const desiredDirection = heightDiff > 0 ? 1 : 0; // 1 = up , 0 = down

    // Safely switch relays: turn off both first to avoid overlap
    clearTravelTimeout();
    relayUp.writeSync(0);
    relayDown.writeSync(0);
    manual = false;
    liftState = 'Locking doors';
    const seq = ++moveSeq;
    noteMoveStart();

    // Only start the motor once every connected level confirms DOOR LOCKED
    lockAllDoorsThen(seq, () => {
      // Control virtual lift (mock mode)
      if (mockLiftMode) {
        mockLiftUpdate(true, desiredDirection);
        console.log(newDateStr(),
          `Controlling virtual lift (mock mode): direction=${
            desiredDirection ? 'up' : 'down'
          }, state=${true}`
        );
      }
      lastDir=desiredDirection
      noteMotorStart();
      relayUp.writeSync(desiredDirection);
      relayDown.writeSync(1 - desiredDirection);
      liftState = desiredDirection ? 'Going UP' : 'Going DOWN';
      trip = { seq, dir: desiredDirection, fromM: currentPositionM(levelPositions[targetLevel]), startTime: Date.now(), expectedMs: expectedTravelMs(currentPositionM(levelPositions[targetLevel]), levelPositions[targetLevel]), mode: 'normal' };
      if (settings.light.auto) setLight(1);
    }, abortMove);
  } else targetLevel = null;
  return true;
}

function tripBlockedReason() {
  if (settings.maintenance.enabled) return 'Maintenance mode: manual moves only';
  if (fault) return `Fault: level ${fault.levels.join(', ')} not responding, trips blocked`;
  return null;
}
app.post('/floor', verifyToken, (req, res) => {
  console.log(newDateStr(),'[floor]', req.body);
  const level = req.body.floor;
  if (level && levelPositions.hasOwnProperty(level)) {
    const blocked = tripBlockedReason();
    if (blocked) {
      console.log(newDateStr(), `Floor request ${level} refused: ${blocked}`);
      res.status(423).json({ error: blocked });
    } else if (liftState === 'Idle') {
      goToFloor(level)
      res.json({ message: `Target level set to ${level}` });
    } else {
      console.log(newDateStr(), `Floor request ${level} canceled: LIFT NOT IDLE (${liftState})`);
      res.status(409).json({ error: 'Lift is moving; try again when idle' });
    }
  } else {
    res.status(400).json({ error: 'Invalid level specified' });
  }
});

app.post('/stop', verifyToken, (req, res) => {
  settings.manual.upEnabled = false;
  settings.manual.downEnabled = false;
  liftOverShot = null
  console.log(newDateStr(),'[STOP]');
  noteStop();
  displayMessage = 'Emergency STOP';
  clearTimeout(clearDisplayMessageTimeout);
   clearDisplayMessageTimeout = setTimeout(() => {
    displayMessage = liftState;
  }, 2000);
  if (mockLiftMode) {
    // Control virtual lift (mock mode)
    const direction = 'none';
    mockLiftUpdate(false, direction);
    console.log(newDateStr(),'Controlling virtual lift (mock mode): STOP');
  }
  moveSeq++;
  clearTravelTimeout();
  relayUp.writeSync(0);
  relayDown.writeSync(0);
  liftState = 'Idle';
  initiatedByButton = false;
  manual = false;
  targetLevel = null;

  virtualLiftMovingDirection = null; // Stop virtual lift movement
  clearInterval(virtualLiftMoveInterval); // Clear interval if running
  if (mockLiftMode) updateMockLevelData(); // Update mock levels based on stopped position

  if (settings.light.currentState && settings.light.auto) {
    clearTimeout(lightTimeoutId);
    lightTimeoutId = setTimeout(() => setLight(0), settings.light.timeout * 1000);
  }

  res.json({});
});

function manualControl(direction, state) {
  if (liftOverShot){
    if (liftOverShot.lastDir) {
      const nextLevelIdx = listOfLevels.indexOf(liftOverShot.levelLabel) + 1
      const nextLevel = listOfLevels[nextLevelIdx]
      currentPosition = `${currentLevel} - ${nextLevel}`
    }
    else {
      const nextLevelIdx = listOfLevels.indexOf(liftOverShot.levelLabel) - 1
      const nextLevel = listOfLevels[nextLevelIdx]
      currentPosition = `${nextLevel} - ${currentLevel}`
    }
    liftOverShot=null
  }

  console.log(newDateStr(), `manualControl called: direction=${direction}, state=${state}`);

  targetLevel = null;
  if (!direction || typeof state !== 'boolean') {
    console.error(newDateStr(), 'Invalid parameters in manualControl');
    return;
  }

  if (direction === 'up' && currentPosition === '2') state = false;
  else if (direction === 'down' && currentPosition === 'B') state = false;

  if (direction !== 'up' && direction !== 'down') {
    console.error(newDateStr(), 'Invalid direction in manualControl');
    return;
  }

  try {
    if (state) {
      // Always switch both directions off first, then the new one on, so the shared GPIO 24 ends up high
      const opposite = direction === 'up' ? relayDown : relayUp;
      const reversing = opposite.readSync() === 1;
      noteStop(); // reversing: the running direction stops here
      const seq = ++moveSeq;
      noteMoveStart();
      clearTravelTimeout();
      relayUp.writeSync(0);
      relayDown.writeSync(0);
      if (mockLiftMode) mockLiftUpdate(false);
      manual = true;
      liftState = 'Locking doors';
      setTimeout(() => {
        if (seq !== moveSeq) return; // cancelled meanwhile
        lockAllDoorsThen(seq, () => {
          if (mockLiftMode) {
            mockLiftUpdate(true, direction === 'up' ? 1 : 0);
            console.log(newDateStr(), `Controlling virtual lift (mock mode): direction=${direction}, state=true`);
          }
          lastDir = direction === 'up' ? 1 : 0;
          noteMotorStart();
          (direction === 'up' ? relayUp : relayDown).writeSync(1);
          liftState = (direction === 'up') ? 'Manual UP' : 'Manual DOWN';
          displayMessage = liftState;
          // Max travel = distance to the end of the shaft in that direction
          const numPosition = currentPositionM(direction === "up" ? levelPositions["2"] : levelPositions["B"]);
          const endPosition = direction === 'up' ? levelPositions['2'] : levelPositions['B'];
          startTravelTimeout(isFinite(numPosition) ? expectedTravelMs(numPosition, endPosition) : expectedTravelMs(levelPositions['B'], levelPositions['2']));
          if (settings.light.auto) setLight(1);
        }, abortMove);
      }, reversing ? REVERSAL_DEAD_TIME_MS : 0);
    } else {
      moveSeq++;
      clearTravelTimeout();
      noteStop();
      if (mockLiftMode) {
        mockLiftUpdate(false, direction === 'up' ? 1 : 0);
        console.log(newDateStr(), `Controlling virtual lift (mock mode): direction=${direction}, state=false`);
      }
      lastDir = direction === 'up' ? 1 : 0;
      (direction === 'up' ? relayUp : relayDown).writeSync(0);
      manual = true;
      liftState = 'Idle';
      displayMessage = 'Manual STOP';
      clearTimeout(clearDisplayMessageTimeout);
      clearDisplayMessageTimeout = setTimeout(() => {
        displayMessage = liftState;
      }, 2000);
      if (settings.light.currentState && settings.light.auto) {
        clearTimeout(lightTimeoutId);
        lightTimeoutId = setTimeout(() => setLight(0), settings.light.timeout * 1000);
      }
    }
  } catch (error) {
    console.error(newDateStr(),'Error controlling GPIO in manualControl:', error);
  }
}
app.post('/heartbeat', verifyToken, (req, res) => {
  // console.error('<3>');
  if (settings.light.auto) setLight(1);
  // lastHeartbeat = Date.now();
  if (settings.light.auto && settings.light.currentState && liftState === 'Idle') {
    clearTimeout(lightTimeoutId);
    lightTimeoutId = setTimeout(() => setLight(0), settings.light.timeout * 1000);
  }
  res.sendStatus(200);
});

app.post('/settings/doors/auto', verifyToken, (req, res) => {
  settings.doors.auto = req.body.value;
  if (settings.doors.auto) {
    Object.entries(levelPack).forEach(([levelLabel, level]) => {
      if (levelLabel === currentLevel && currentLevel !== 'none') {
        level.port.write('UNLOCK_DOOR\r\n', (err) => {
          if (err) {
            console.error(newDateStr(), `Error unlocking door at level ${levelLabel}:`, err.message);
          } else {
            console.log(newDateStr(), `UNLOCK_DOOR sent to level ${levelLabel} on enabling auto doors`);
          }
        });
      } else {
        level.port.write('LOCK_DOOR\r\n', (err) => {
          if (err) {
            console.error(newDateStr(), `Error locking door at level ${levelLabel}:`, err.message);
          } else {
            console.log(newDateStr(), `LOCK_DOOR sent to level ${levelLabel} on enabling auto doors`);
          }
        });
      }
    });
  }
  res.json({ success: true });
});

app.post('/settings/doors/open-all', verifyToken, (req, res) => {
  if (!settings.doors.auto) {
    Object.values(levelPack).forEach(level => {
      level.port.write('UNLOCK_DOOR\r\n', (err) => {
        if (err) console.error(newDateStr(), 'Error writing UNLOCK_DOOR:', err);
      });
    });
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'Cannot open all when auto enabled' });
  }
});

app.post('/settings/doors/lock-all', verifyToken, (req, res) => {
  if (!settings.doors.auto) {
    Object.values(levelPack).forEach(level => {
      level.port.write('LOCK_DOOR\r\n', (err) => {
        if (err) console.error(newDateStr(), 'Error writing LOCK_DOOR:', err);
      });
    });
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'Cannot lock all when auto enabled' });
  }
});

app.post('/settings/light/auto', verifyToken, (req, res) => {
  settings.light.auto = req.body.value;
  if (settings.light.auto && (liftState !== 'Idle' /*|| Object.values(levelPack).some(l => !l.state.doorClosed)*/)) {
    setLight(1);
  }
  res.json({ success: true });
});

app.post('/settings/light/switch', verifyToken, (req, res) => {
  if (!settings.light.auto) {
    setLight(req.body.value ? 1 : 0);
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'Cannot manually switch light when auto enabled' });
  }
});

app.post('/settings/light/timeout', verifyToken, (req, res) => {
  settings.light.timeout = +req.body.value;
  console.log(newDateStr(),
    `settings.light.timeout = ${JSON.stringify(req.body)}`
  );
  res.json({ success: true });
});

app.post('/settings/call-buttons/enable', verifyToken, (req, res) => {
  console.log(newDateStr(),
    `settings.callButton.enabled = ${JSON.stringify(req.body)}`
  );
  settings.callButton.enabled = req.body.value;
  res.json({ success: true });
});

app.post('/settings/maintenance/enabled', verifyToken, (req, res) => {
  setMaintenance(!!req.body.value, 'from client');
  res.json({ success: true, maintenance: settings.maintenance });
});

app.post('/settings/manual/up', verifyToken, (req, res) => {
  console.log(newDateStr(),
    `settings.manual.upEnabled = ${JSON.stringify(req.body)}`
  );
  settings.manual.upEnabled = req.body.value;
  manualControl('up', req.body.value); // NEW: Call the refactored function
  res.json({ success: true });
});

app.post('/settings/manual/down', verifyToken, (req, res) => {
  console.log(newDateStr(),
    `settings.manual.downEnabled = ${JSON.stringify(req.body)}`
  );
  settings.manual.downEnabled = req.body.value;
  manualControl('down', req.body.value); // NEW: Call the refactored function
  res.json({ success: true });
});

// // Periodic check for inactivity
// setInterval(() => {
//   if (Date.now() - lastHeartbeat > INACTIVE_THRESHOLD && !initiatedByButton) {
//     relayUp.writeSync(0);
//     relayDown.writeSync(0); // Immediate off for relays (safety)
//     if (settings.light.auto) {
//       setLight(1); // Ensure on before starting timeout
//       clearTimeout(lightTimeoutId);
//       lightTimeoutId = setTimeout(() => setLight(0), settings.light.timeout * 1000);
//     } else {
//       setLight(0); // Immediate off if timeout disabled
//     }
//   }
// }, HEARTBEAT_INTERVAL);

// Monitor levelPack completeness every 30 seconds
setInterval(() => {
  const connectedLevels = Object.keys(levelPack);
  const missingLevels = listOfLevels.filter(level => !connectedLevels.includes(level));
  if (missingLevels.length > 0) {
    console.error(newDateStr(), `Missing levels in levelPack: ${missingLevels.join(', ')}`);
  } 
  // else {
  //   console.log(newDateStr(), 'All levels connected in levelPack.');
  // }
}, 10000);


app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
});


http.createServer(app).listen(PORT, () => {
  console.log(newDateStr(),`Server running on http://localhost:${PORT}`);
});

process.on('uncaughtException', (error) => {
  console.error(newDateStr(), 'Uncaught Exception:', error);
  // Optional: Add recovery logic here if needed, but avoid process.exit() to keep server running
});

process.on('SIGINT', () => {
  console.log(newDateStr(), 'SIGINT received - shutting down gracefully');
  try {
    turnOffRelays();
    closeAllPorts(); // New: Graceful port closure
    lightSwitch(0)
  } catch (error) {
    console.error(newDateStr(),'Error during shutdown:', error);
  }
  process.exit(0);
});