const express = require('express');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { execSync } = require('child_process');
const path = require('path');

// Virtual lift state variables
let virtualLiftPosition = 0; // Initial position at G level
let virtualLiftTargetLevel = 'G'; // Initial target level
let virtualLiftMovingDirection = null; // Not moving initially
const levelHeight = 3; // Height of each level in meters
const levelPositions = { // Level positions in meters
  'B': -3,
  'G': 0,
  '1': 3,
  '2': 6,
};
const positionTolerance = 0.01; // 1cm tolerance for "LIFT HERE"
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const https = require('https');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const cors = require('cors');

class GpioRelayGroup {
  constructor(id0, id1, type) {
    this.id0 = id0;
    this.id1 = id1;
    this.type = type;
    this.state = 0;
  }
  readSync() {
    return this.state;
  }
  writeSync(state) {
    if (this.state !== state) {
      this.state = state;
      console.log(`GPIOs #${this.id0}/#${this.id1} > ${this.state}`);
      execSync('gpioset 0 ' + this.id0 + '=' + this.state); // ignoring output, no need to print an empty Buffer
      execSync('gpioset 0 ' + this.id1 + '=' + this.state);
    }
  }
}

// Array to store serial ports and parsers
const ports = [];
const parsers = [];
const portPaths = [
  '/dev/cu.usbserial-40',
  '/dev/cu.usbserial-41',
  '/dev/cu.usbserial-42',
  '/dev/cu.usbserial-43',
];

// Object to store current levels for each floor
const currentLevels = {
  'B': null,
  'G': null,
  '1': null,
  '2': null,
};

// Function to parse serial data and determine the level
function parseLevelData(data, clientId) { // Added clientId parameter
  const parts = data.split(' : ');
  if (parts.length === 2) {
    const message = parts[1];
    if (message === 'LIFT HERE') {
      currentLevels[clientId] = 'LIFT HERE';
    } else if (message === 'LIFT AWAY') {
      currentLevels[clientId] = 'LIFT AWAY';
    }
  }
}

function createMockSerialDataGenerator(clientId) { // Removed initialLevel parameter
  console.log(`Creating mock data generator for ${clientId}`); // Log mock data generator creation

  updateMockLevelData(); // Call updateMockLevelData to set initial level based on virtualLiftPosition
  console.log(`Mock data generator for ${clientId} initialized to: ${clientId} : ${currentLevels[clientId]}`); // Log initial level
}

function updateMockLevelData() {
  const tolerance = positionTolerance;
  for (const level in levelPositions) {
    const levelPosition = levelPositions[level];
    const positionDiff = Math.abs(virtualLiftPosition - levelPosition);
    if (positionDiff <= tolerance) {
      currentLevels[level] = 'LIFT HERE';
    } else {
      currentLevels[level] = 'LIFT AWAY';
    }
    // Send mock serial data update (important to keep this for mock data to be sent)
    const clientId = level; // ClientId is the floor level in this context
    const levelStatus = currentLevels[level];
    const mockData = `${clientId} : ${levelStatus}`;
    console.log(`Mock data update: ${mockData}`);
    parseLevelData(mockData, clientId);
  }
}

function updateMockLevelData() {
  const tolerance = positionTolerance;
  for (const level in levelPositions) {
    const levelPosition = levelPositions[level];
    const positionDiff = Math.abs(virtualLiftPosition - levelPosition);
    if (positionDiff <= tolerance) {
      currentLevels[level] = 'LIFT HERE';
    } else {
      currentLevels[level] = 'LIFT AWAY';
    }
  }
}


// Initialize serial ports and parsers
portPaths.forEach((path, index) => {
  const clientId = ['B', 'G', '1', '2'][index];
  console.log(`Attempting to initialize serial port: ${path}`); // Log before SerialPort

  const port = new SerialPort({ path: path, baudRate: 57600 });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
  ports.push(port);
  parsers.push(parser);

  port.on("open", () => {
    console.log(`PORT OPEN ${path}`, port.settings.path); // Log if port opens successfully
    console.log(port.settings);
    console.log("port.isOpen", port.isOpen);
  });

  parser.on('data', data => {
    console.log(`Data from ${path}: ${data}`);
    parseLevelData(data, clientId); // Call the parsing function with clientId
  });

  port.on('error', error => { // Attach error listener to port, not parser
    console.error(`Serial port error for ${path}: ${error}`);
    console.error(`Error type (port.on('error')): ${error.constructor.name}`); // Log error type
    console.error(`Full error object (port.on('error'))::`, error); // Log full error object
    console.log(`Initializing mock data generator due to serial port error for ${path}`); // Log mock data generator execution
    createMockSerialDataGenerator(clientId); // Corrected: Call mock data generator (no initialLevel parameter)
  });
  console.log(`port.on('error') listener attached for ${path}`); // Log after attaching error listener
});


function createMockSerialDataGenerator(clientId) { // Removed initialLevel parameter, removed setInterval
  console.log(`Creating mock data generator for ${clientId}`); // Log mock data generator creation

  updateMockLevelData(); // Call updateMockLevelData to set initial level based on virtualLiftPosition
  console.log(`Mock data generator for ${clientId} initialized to: ${clientId} : ${currentLevels[clientId]}`); // Log initial level
}

const app = express();

app.use((req, res, next) => {
  if (!['/status','/heartbeat'].includes(req.url))
  console.log('REQURL :',new Date(),req.url);
  next();
});
app.use(cookieParser());
app.use(cors({
  origin: 'http://localhost:3000', // Allow HTTP origin for development
  credentials: true
}));
const PORT = process.env.PORT || 5000;

const options = {
  key: fs.readFileSync('./server.key'),
  cert: fs.readFileSync('./server.crt')
};

// JWT secret keys
const accessTokenSecret = 'your_access_token_secret';
const refreshTokenSecret = 'your_refresh_token_secret';

// User credentials (in a real app, store these securely, e.g., in a database)
const user = {
  username: 'Spok',
  password: bcrypt.hashSync('31415', 10)
};

// Set up GPIO pins for relays (adjust pin numbers as needed)
let relayUp, relayDown;
try {
  relayDown = new GpioRelayGroup(12, 16, 'out');
  relayUp = new GpioRelayGroup(23, 24, 'out');
} catch (error) {
  console.error('Error initializing GPIO:', error);
  process.exit(1);
}

app.use(express.static(path.join(__dirname, 'client/build')));
app.use(express.json());

let lastHeartbeat = Date.now();
const HEARTBEAT_INTERVAL = 1000; // 5 seconds
const INACTIVE_THRESHOLD = 2000; // 10 seconds

// Function to turn off both relays
function turnOffRelays() {
  try {
    if (relayDown.readSync()===0 && relayUp.readSync()===0) return
    relayUp.writeSync(0);
    relayDown.writeSync(0);
    console.log('Both relays turned off due to inactivity');
  } catch (error) {
    console.error('Error turning off relays:', error);
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Middleware to verify JWT
const verifyToken = (req, res, next) => {
  // console.log('req.url:', req.url);
  const token = req.cookies.accessToken;
  // console.log('Received token:', token);

  if (!token) {
    if (req.url === '/check-auth' && !req.cookies.refreshToken) return res.status(401).json({ error: 'Access token required' });
    else return res.status(403).json({ error: 'Access token required' });
  }
  jwt.verify(token, accessTokenSecret, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = decoded;
    next();
  });
};

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // In a real application, you would validate against a database
  if (username === user.username && bcrypt.compareSync(password, user.password)) {
    // Generate tokens
    const accessToken = jwt.sign({ username: user.username }, accessTokenSecret, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ username: user.username }, refreshTokenSecret, { expiresIn: '7d' });

    // Set tokens as HttpOnly cookies
    res.cookie('accessToken', accessToken, { httpOnly: true, secure: true, sameSite: 'Strict' });
    res.cookie('refreshToken', refreshToken, { httpOnly: true, secure: true, sameSite: 'Strict' });

    return res.status(200).json({ message: 'Login successful' });
  } else {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
});

app.post('/refresh-token', (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  jwt.verify(refreshToken, refreshTokenSecret, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid refresh token' });
    }

    // In real application, you should check if the refresh token is still valid in database

    const accessToken = jwt.sign({ username: decoded.username }, accessTokenSecret, { expiresIn: '15m' });
    res.cookie('accessToken', accessToken, { httpOnly: true, secure: true, sameSite: 'Strict' });
    return res.status(200).json({ message: 'Access token refreshed' });
  });
});

app.get('/status', verifyToken, (req, res) => {
  try {
    res.json({
      up: relayUp.readSync(),
      down: relayDown.readSync(),
      currentLevels: currentLevels, // Updated to return currentLevels object
    });
  } catch (error) {
    console.error('Error reading GPIO status:', error);
    res.status(500).json({ error: 'Error reading lift status' });
  }
});

app.post('/floor', verifyToken, (req, res) => {
  console.log('[floor]',req.body)
  res.json({})
})

app.post('/stop', verifyToken, (req, res) => {
  console.log('[STOP]');
  relayUp.writeSync(0);
  relayDown.writeSync(0);

  virtualLiftMovingDirection = null; // Stop virtual lift movement
  clearInterval(virtualLiftMoveInterval); // Clear interval if running
  updateMockLevelData(); // Update mock levels based on stopped position

  res.json({});
});

let virtualLiftMoveInterval; // Variable to hold the interval

app.post('/control', verifyToken, (req, res) => {
  const { direction, state } = req.body;

  if (!direction || typeof state !== 'boolean') {
    return res.status(400).json({ error: 'Invalid request parameters' });
  }

  if (ports.length === 0) {
    // Control virtual lift if serial ports are not available (mock mode)
    console.log(`Controlling virtual lift: direction=${direction}, state=${state}`);
    if (state) {
      virtualLiftMovingDirection = direction;
      if (!virtualLiftMoveInterval) { // Prevent multiple intervals
        virtualLiftMoveInterval = setInterval(() => {
          const step = direction === 'up' ? 0.1 : -0.1; // 0.1m step per interval
          virtualLiftPosition += step;

          // Basic boundary checks (can be refined)
          virtualLiftPosition = Math.max(-3, Math.min(6, virtualLiftPosition)); // Limit to [-3, 6] range
          console.log(`Virtual lift position updated: ${virtualLiftPosition}`);
          updateMockLevelData(); // Update mock levels based on new position

          if (virtualLiftTargetLevel) { // Check if target level is set
            const targetPosition = levelPositions[virtualLiftTargetLevel];
            if (Math.abs(virtualLiftPosition - targetPosition) <= positionTolerance) {
              clearInterval(virtualLiftMoveInterval);
              virtualLiftMoveInterval = null;
              virtualLiftMovingDirection = null;
              console.log(`Virtual lift reached target level: ${virtualLiftTargetLevel}, position: ${virtualLiftPosition}`);
              updateMockLevelData(); // Final level update when target reached
            }
          }
        }, 200); // Interval for movement simulation (adjust as needed)
      }
    } else {
      virtualLiftMovingDirection = null;
      clearInterval(virtualLiftMoveInterval); // Clear interval if running
      virtualLiftMoveInterval = null;
      updateMockLevelData(); // Update mock levels when lift stops
    }
    return res.sendStatus(200);
  }

  // Control real relays if serial ports are available
  try {
    if (direction === 'up') {
      relayUp.writeSync(state ? 1 : 0);
      if (state) relayDown.writeSync(0);
    } else if (direction === 'down') {
      relayDown.writeSync(state ? 1 : 0);
      if (state) relayUp.writeSync(0);
    } else {
      return res.status(400).json({ error: 'Invalid direction' });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error controlling GPIO:', error);
    res.status(500).json({ error: 'Error controlling lift' });
  }
});

app.post('/heartbeat', verifyToken, (req, res) => {
  lastHeartbeat = Date.now();
  res.sendStatus(200);
});

// Periodic check for inactivity
setInterval(() => {
  if (Date.now() - lastHeartbeat > INACTIVE_THRESHOLD) {
    turnOffRelays();
  }
}, HEARTBEAT_INTERVAL);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
});

https.createServer(options, app).listen(PORT, () => {
  console.log(`Server running on https://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  try {
    turnOffRelays();
    // relayUp.unexport();
    // relayDown.unexport();
  } catch (error) {
    console.error('Error during shutdown:', error);
  }
  process.exit();
});
