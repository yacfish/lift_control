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
let mockGeneratorCount = 0; // Counter for mock generator calls
const mockLevelObject = {}
const levelPositions = { // Level positions in meters
  'B': -3,
  'G': 0,
  '1': 3,
  '2': 6,
};
const positionTolerance = 0.05; // 1cm tolerance for "LIFT HERE"
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const https = require('https');
// const http = require('http');

const fs = require('fs');
const cookieParser = require('cookie-parser');
const cors = require('cors');

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
      console.log(`GPIOs #${this.id0} and #${this.id1} ('${this.label}') set to ${this.state? 'ON' : 'OFF'}${mockLiftMode? ' (Virtual)' : ''}`);
      if (!mockLiftMode){
        execSync('gpioset 0 ' + this.id0 + '=' + this.state); // ignoring output, no need to print an empty Buffer
        execSync('gpioset 0 ' + this.id1 + '=' + this.state);
      }
    }
  }
}

// Array to store serial ports and parsers
const ports = [];
const parsers = [];
const portPaths = [
  '/dev/ttyUSB0',
  '/dev/ttyUSB1',
  '/dev/ttyUSB2',
  '/dev/ttyUSB3'
];
const listOfLevels = ['B', 'G', '1', '2']

// Object to store current levels for each floor
const currentLevels = {};
listOfLevels.forEach(level=>{currentLevels[level]=null})
    
let currentLevel = 'none'
let currentPosition = 'none'

// Function to parse serial data and determine the level
function parseLevelData(data) {
  const parts = data.split(' : ');
  const level = parts[0];
  if (parts.length === 2) {
    const message = parts[1];
    if (message === 'LIFT HERE') {
      currentLevel = level
      currentPosition = level
      currentLevels[level] = 'LIFT HERE';
      if (targetLevel === currentLevel || currentLevel === 'B' || currentLevel === '2') {
        console.log(`PRESENCE SENSOR TRIGGERED > Lift reached target level: ${targetLevel}`);
        relayUp.writeSync(0);
        relayDown.writeSync(0);
        clearInterval(virtualLiftMoveInterval);
        virtualLiftMoveInterval = null;
        virtualLiftMovingDirection = null;
        targetLevel = null;
      } else {
        console.log(`PRESENCE SENSOR TRIGGERED > Lift reached level: ${currentLevel}`);
      }
    } else if (message === 'LIFT AWAY') {
      currentLevels[level] = 'LIFT AWAY';
      console.log(`PRESENCE SENSOR TRIGGERED > Lift left level ${level}`);
      if (relayUp.readSync()) {
        const nextLevelIdx = listOfLevels.indexOf(level) + 1
        const nextLevel = listOfLevels[nextLevelIdx]
        currentPosition = `${currentLevel} - ${nextLevel}`
      }
      else if (relayDown.readSync()) {
        const nextLevelIdx = listOfLevels.indexOf(level) - 1
        const nextLevel = listOfLevels[nextLevelIdx]
        currentPosition = `${nextLevel} - ${currentLevel}`
      }
    }
  }
  
}

function createMockSerialDataGenerator(portPath) { // Removed initialLevel parameter
  console.log(`Creating mock data generator for ${portPath}`); // Log mock data generator creation

  mockGeneratorCount++; // Increment mock generator call count
  if (mockGeneratorCount >= 4) {
    mockLiftMode = true;
    console.error('Mock Lift Mode Activated');
  }

  updateMockLevelData(); // Call updateMockLevelData to set initial level based on virtualLiftPosition

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


// Initialize serial ports and parsers
portPaths.forEach((path) => {
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
    parseLevelData(data); // Call the parsing function
  });

  port.on('error', error => { // Attach error listener to port, not parser
    console.error(`Serial port error for ${path}: ${error}`);
    console.error(`Error type (port.on('error')): ${error.constructor.name}`); // Log error type
    console.error(`Full error object (port.on('error'))::`, error); // Log full error object
    console.log(`Initializing mock data generator due to serial port error for ${path}`); // Log mock data generator execution
    createMockSerialDataGenerator(); // Corrected: Call mock data generator (no initialLevel parameter)
  });
  console.log(`port.on('error') listener attached for ${path}`); // Log after attaching error listener
});



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

relayDown = new GpioRelayGroup(12, 16, 'DOWN');
relayUp = new GpioRelayGroup(23, 24, 'UP');

} catch (error) {
  relayDown = false;
  relayUp = false;
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

app.get('/check-auth', verifyToken, (req, res) => { // Added /check-auth endpoint
    res.status(200).json({ message: 'Authenticated' }); // Return 200 if token is valid
});

app.post('/logout', verifyToken, (req, res) => {
  // Clear access and refresh tokens by setting empty cookies with immediate expiry
  res.cookie('accessToken', '', { httpOnly: true, secure: true, sameSite: 'Strict', expires: new Date(0) });
  res.cookie('refreshToken', '', { httpOnly: true, secure: true, sameSite: 'Strict', expires: new Date(0) });
  return res.status(200).json({ message: 'Logout successful' });
});

app.get('/status', verifyToken, (req, res) => {
    try {
    // const currentLevelsDisplay = {}
    // console.log(currentLevels)
    // listOfLevels.forEach(level=>{currentLevelsDisplay[level]=(level==currentLevel)? 'LIFT HERE' : 'LIFT AWAY'})
    let resObj = {
      up: relayUp.readSync(),
      down: relayDown.readSync(),
      // currentLevels: currentLevels, // Updated to return currentLevels object
      currentPosition,
      targetLevel
    }
    res.json(resObj);
    // if (resObj.up || resObj.down) console.error('resObj : ', resObj);
  } catch (error) {
    console.error('Error reading GPIO status:', error);
    res.status(500).json({ error: 'Error reading lift status' });
  }
});

function mockLiftUpdate(state, direction){
  if (state) {
    if (!virtualLiftMoveInterval) { // Prevent multiple intervals
      virtualLiftMoveInterval = setInterval(() => {
        const step = (direction === 1)? 0.05 : -0.05;
        virtualLiftPosition += step;

        // Basic boundary checks (can be refined)
        virtualLiftPosition = Math.max(-3, Math.min(6, virtualLiftPosition)); // Limit to [-3, 6] range
        console.log(`Virtual lift position updated: ${virtualLiftPosition}`);
        updateMockLevelData(); // Update mock levels based on new position

        
      }, 100); // Interval for movement simulation (adjust as needed)
    }
  } else {
    clearInterval(virtualLiftMoveInterval); // Clear interval if running
    virtualLiftMoveInterval = null;
    updateMockLevelData(); // Update mock levels when lift stops
  }
}
app.post('/floor', verifyToken, (req, res) => {
  console.log('[floor]',req.body);
  const level = req.body.floor;
  if (level && levelPositions.hasOwnProperty(level)) {
    targetLevel = level;
    console.log(`Lift target level updated to: ${targetLevel}`);
    res.json({ message: `Target level set to ${level}` });
    if(currentPosition!= targetLevel){
      let numPosition
      if (currentPosition.includes('-')) numPosition = levelPositions[currentPosition.split(' - ')[0]]+1.5
      else numPosition = levelPositions[currentPosition]
      console.log('numPosition : ',numPosition)
      const heightDiff = levelPositions[targetLevel] - numPosition;
      const desiredDirection = heightDiff > 0 ? 1 : 0;
      
      if (mockLiftMode) {
        // Control virtual lift (mock mode)
        mockLiftUpdate(true, desiredDirection)
        console.log(`Controlling virtual lift (mock mode): direction=${(desiredDirection? 'up' : 'down')}, state=${true}`);
        
      }
      
      relayUp.writeSync(desiredDirection);
      relayDown.writeSync(1-desiredDirection);
    } else targetLevel=null;
  } else {
    res.status(400).json({ error: 'Invalid level specified' });
  }
})

app.post('/stop', verifyToken, (req, res) => {
  console.log('[STOP]');
  if (mockLiftMode) {
    // Control virtual lift (mock mode)
    const direction = 'none'
    mockLiftUpdate(false, direction)
    console.log('Controlling virtual lift (mock mode): STOP');
    
  }
  relayUp.writeSync(0);
  relayDown.writeSync(0);

  virtualLiftMovingDirection = null; // Stop virtual lift movement
  clearInterval(virtualLiftMoveInterval); // Clear interval if running
  updateMockLevelData(); // Update mock levels based on stopped position

  res.json({});
});

app.post('/control', verifyToken, (req, res) => {
  let { direction, state } = req.body;
  console.log('/control req.body :\n',req.body);
  
  targetLevel=null;
  if (!direction || typeof state !== 'boolean') {
    return res.status(400).json({ error: 'Invalid request parameters' });
  }

  if (direction === 'up' && currentPosition==='2') state = false;
  else if (direction === 'down' && currentPosition==='B') state = false;

  if (mockLiftMode) {
    // Control virtual lift (mock mode)
    mockLiftUpdate(state, direction=== 'up'? 1 : 0)
    console.log(`Controlling virtual lift (mock mode): direction=${direction}, state=${state}`);
    
  }

  // Control real relays weather serial ports are available or not
  // this is necessary to update the relayUp and relayDown states
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
    // console.error('Error controlling GPIO');
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

app.get('/server.crt', (req, res) => {
  res.sendFile(path.join(__dirname, 'server.crt'));
});

https.createServer(options, app).listen(PORT, () => {
  console.log(`Server running on https://localhost:${PORT}`);
});

// http.createServer(app).listen(PORT, () => {
//   console.log(`Server running on http://localhost:${PORT}`);
// });
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
