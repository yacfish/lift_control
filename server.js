const express = require('express');
const { execSync } = require('child_process');
class GpioRelayGroup {
  constructor(id0,id1,type){
    this.id0 = id0
    this.id1 = id1
    this.type = type
    this.state = 0
  }
  readSync (){
    return this.state
  }
  writeSync (state){
    if (this.state !== state){
      this.state = state
      console.log(`GPIOs #${this.id0}/#${this.id1} > ${this.state}`)
      execSync('gpioset 0 '+this.id0+'='+this.state)// ignoring output, no need to print an empty Buffer
      execSync('gpioset 0 '+this.id1+'='+this.state)
    }
  }
}
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const https = require('https');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const app = express();


app.use((req, res, next) => {
  if (!['/status','/heartbeat'].includes(req.url))
  console.log('REQURL :',new Date(),req.url);
  next();
});
app.use(cookieParser());
app.use(cors({
  origin: 'https://localhost:3000', // Your React app's URL
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

app.get('/check-auth', verifyToken, (req, res) => {
  // If the middleware passes, the user is authenticated
  res.json({ authenticated: true, user: req.user });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  console.log ( 'login:',username )
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  if (username === user.username && bcrypt.compareSync(password, user.password)) {
    const accessToken = jwt.sign({ username }, accessTokenSecret, { expiresIn: '5m' });
    const refreshToken = jwt.sign({ username }, refreshTokenSecret, { expiresIn: '7d' });
    
    // Set access token in HTTP-only cookie
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 5 * 60 * 1000 // 5 minutes
    });

    // Set refresh token in HTTP-only cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.json({ message: 'Login successful' });
    // console.log(res)
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Logout route to clear cookies
app.post('/logout', (req, res) => {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  console.log({ message: 'Logged out successfully' });
  res.json({ message: 'Logged out successfully' });
});

app.post('/refresh-token', (req, res) => {
  const { refreshToken } = req.cookies
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token provided' });

  jwt.verify(refreshToken, refreshTokenSecret, (err, decoded) => {
    if (err) {
      console.log('error : invalid refresh token')
      console.log(err)
      return res.status(401).json({ error: 'Invalid refresh token' })
    }
    const accessToken = jwt.sign({ username: decoded.username }, accessTokenSecret, { expiresIn: '5m' });
    
    // Set new access token in HTTP-only cookie
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 5 * 60 * 1000 // 5min
    });
    console.log({ message: 'Token refreshed successfully' });
    res.json({ message: 'Token refreshed successfully' });
  });
});

app.get('/status', verifyToken, (req, res) => {
  try {
    res.json({
      up: relayUp.readSync(),
      down: relayDown.readSync()
    });
  } catch (error) {
    console.error('Error reading GPIO status:', error);
    res.status(500).json({ error: 'Error reading lift status' });
  }
});

app.post('/control', verifyToken, (req, res) => {
  const { direction, state } = req.body;
  
  if (!direction || typeof state !== 'boolean') {
    return res.status(400).json({ error: 'Invalid request parameters' });
  }

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