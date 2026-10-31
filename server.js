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
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
// const https = require('https');
const http = require('http');

const fs = require('fs');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const settings = {
  doors: { auto: true },
  light: { auto: true, timeout: 60, currentState: false },
  callButton: { enabled: true },
  manual: { upEnabled: false, downEnabled: false }
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
    
let currentLevel = 'none';
let currentPosition = 'none';
let displayMessage = 'Idle';
let liftState = 'Idle';
let manual = false;
let clearDisplayMessageTimeout;

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

// Function to parse serial data and determine the level
function parseLevelData(data, port=null) {
  const parts = data.split(' : ');
  const levelLabel = parts[0];
  if (parts.length === 2) {
    const message = parts[1];
    if (message === 'LIFT HERE') {
      liftOverShot=null;
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
        relayUp.writeSync(0);
        relayDown.writeSync(0);
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
      levelPack[levelLabel].state.presence = null;
      console.log(newDateStr(),`PRESENCE SENSOR TRIGGERED > Lift left level ${levelLabel}`);
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
      else {
        console.log(newDateStr(),`LIFT OVERSHOT @ level ${levelLabel} while going ${lastDir?"UP":"DOWN"}`);
        liftOverShot = {levelLabel,lastDir}
      }
    } else if (message === 'DOOR OPEN') {
      levelPack[levelLabel].state.doorClosed = false;
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
      if (here) currentPosition = parts[0]
      if (!levelPack[parts[0]]) levelPack[parts[0]] = { port, state: { presence: here ? 'LIFT HERE' : null, doorClosed: true, doorLocked: true } };
      else levelPack[parts[0]].state.presence = here ? 'LIFT HERE' : null
    } 
  }
}


function createMockSerialDataGenerator(portPath) {
  console.log(newDateStr(),`Creating mock data generator for ${portPath}`);
}

function updateMockLevelData() {
  const tolerance = positionTolerance;
  for (const level in levelPositions) {
    const levelPosition = levelPositions[level];
    const positionDiff = Math.abs(virtualLiftPosition - levelPosition);
 
    const levelStatus = (positionDiff <= tolerance)? 'LIFT HERE' : 'LIFT AWAY';
    const mockLevelData = `${level} : ${levelStatus}`;
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
        listOfLevels.forEach(level => {
          levelPack[level] = {
            port: {
              write: (data, cb) => { console.log(newDateStr(), `Mock write to ${level}: ${data}`); if (cb) cb(null); },
              settings: { path: `Mock_${level}` } // FIXED: Add mock path for logging
            },
            state: { presence: null, doorClosed: true, doorLocked: true }
          };
        });
        currentLevel = 'G';
        levelPack['G'].state.presence = 'LIFT HERE'; // Set initial presence
        currentPosition = 'G';
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
    // Clear any existing timeout first
    if (retryTimeouts[index]) {
      clearTimeout(retryTimeouts[index]);
      retryTimeouts[index] = null;
    }
    // Set exponential backoff timeout only if not in mock mode
    if (!mockLiftMode) {
      const delay = retryBackoffs[index];
      retryTimeouts[index] = setTimeout(() => {
        retryTimeouts[index] = null; // Clear after firing
        openSerialPort(path, index, false);
        // Double backoff for next time (cap at 60s)
        retryBackoffs[index] = Math.min(retryBackoffs[index] * 2, 60000);
      }, delay);
    }
  });
}

console.log(newDateStr(),'--------------------');
console.log(newDateStr(),'STARTING LIFT SERVER');
console.log(newDateStr(),'--------------------');

// Initialize serial ports
portPaths.forEach((path, index) => {
  openSerialPort(path, index, true);
});

// Periodic heartbeat check (tweaked: 20s threshold, check every 5s for faster response)
setInterval(() => {
  if (mockLiftMode) return; // Skip in mock mode
  portPaths.forEach((path, index) => {
    if (Date.now() - lastDataTimes[index] > 20000) { // 20s threshold
      console.error(newDateStr(), `Stale heartbeat for ${path} (>20s), forcing reconnect`);
      runtimeErrorCount++; // Count as runtime error
      if (ports[index] && ports[index].isOpen) {
        if (retryTimeouts[index]) {
          clearTimeout(retryTimeouts[index]);
          retryTimeouts[index] = null;
        }
        ports[index].close();
      }
    }
  });
}, 5000); // Check every 5s

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

function mockLiftUpdate(state, direction){
  if (state) {
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
    clearInterval(virtualLiftMoveInterval); // Clear interval if running
    virtualLiftMoveInterval = null;
    updateMockLevelData(); // Update mock levels when lift stops
  }
}
function goToFloor(newTargetLevel){
  if (listOfLevels.includes(currentLevel)){
    try {
      if (levelPack[currentLevel]) {
        const level = levelPack[currentLevel];
        level.port.write('LOCK_DOOR\r\n',function(err){
          if (err) {return console.error("error on write", err.message)}
          console.log(newDateStr(),"message sent to "+ currentLevel + " (" + (level && level.port && level.port.settings ? level.port.settings.path : 'Mock') + ") : LOCK_DOOR")
        })
      }
    } catch (error) {
      console.error(newDateStr(), 'Error locking door for current level:', error);
    }
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
    relayUp.writeSync(0);
    relayDown.writeSync(0);

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
    relayUp.writeSync(desiredDirection);
    relayDown.writeSync(1 - desiredDirection);
    liftState = desiredDirection ? 'Going UP' : 'Going DOWN';
    manual = false;
    if (settings.light.auto) setLight(1);
  } else targetLevel = null;
}
app.post('/floor', verifyToken, (req, res) => {
  console.log(newDateStr(),'[floor]', req.body);
  const level = req.body.floor;
  if (level && levelPositions.hasOwnProperty(level)) {
    if (liftState === 'Idle') {
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
  relayUp.writeSync(0);
  relayDown.writeSync(0);
  liftState = 'Idle';
  initiatedByButton = false;
  manual = false;
  targetLevel = null;

  virtualLiftMovingDirection = null; // Stop virtual lift movement
  clearInterval(virtualLiftMoveInterval); // Clear interval if running
  updateMockLevelData(); // Update mock levels based on stopped position

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

  if (mockLiftMode) {
    // Control virtual lift (mock mode)
    mockLiftUpdate(state, direction === 'up' ? 1 : 0);
    console.log(newDateStr(),
      `Controlling virtual lift (mock mode): direction=${direction}, state=${state}`
    );
  }

  // Control the real relays whether serial ports are available or not
  try {
    if (direction === 'up') {
      lastDir = 1;
      relayUp.writeSync(state ? 1 : 0);
      if (state) relayDown.writeSync(0);
    } else if (direction === 'down') {
      lastDir = 0;
      relayDown.writeSync(state ? 1 : 0);
      if (state) relayUp.writeSync(0);
    } else {
      console.error(newDateStr(), 'Invalid direction in manualControl');
      return;
    }
    manual = true;
    
    if (state) {
      liftState = (direction === 'up') ? 'Manual UP' : 'Manual DOWN';
      displayMessage = liftState;
      if (settings.light.auto) setLight(1);
    } else {
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