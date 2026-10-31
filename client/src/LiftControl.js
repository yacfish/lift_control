// LiftControl.js
import React, { useState, useEffect, useCallback, useRef } from 'react';
import './LiftControl.css';

import {ReactComponent as StopImg} from './images/stop.svg';
import {ReactComponent as HomeImg} from './images/home.svg';
import {ReactComponent as SettingsImg} from './images/settings.svg';
import Settings from './Settings'; // NEW: Import Settings component

// Import the API instance from App.js
import { api } from './App';

let positionBgY = 0;

const HEARTBEAT_INTERVAL = 1000; // NEW: Define heartbeat interval (30s)

function LiftControl({ setIsAuthenticated, authDisabled }) {
  // TEMP DEBUG: Log prop value on mount (remove after testing)
  console.log('LiftControl mounted with authDisabled:', authDisabled);

  const [status, setStatus] = useState({ up: false, down: false, currentPosition: '', displayMessage: 'Idle' }); 
  const [mode, setMode] = useState('home');
  const [error, setError] = useState('');
  const [selectedFloor, setSelectedFloor] = useState(null); // Track the currently selected floor
  const [position, setPosition] = useState("Unknown"); // Track the current lift position
  const [settingsState, setSettingsState] = useState({ // FIXED: Initialize with defaults
    doors: { auto: true },
    light: { auto: true, currentState: false, timeout: 60 },
    callButton: { enabled: true },
    manual: { upEnabled: false, downEnabled: false },
    maintenance: { enabled: false, until: null }
  });
  const prevIsMovingRef = useRef(false); // NEW: Ref to track previous moving state (add this line if missing)

  const containerRef = useRef(null);
  const animationRef = useRef(null);
  const showSettingsRef = useRef(null);
  const showHomeRef = useRef(null);
  const showSettingsButtonRef = useRef(null);
  const showHomeButtonRef = useRef(null);
  const btnFloor2 = useRef(null);
  const btnFloor1 = useRef(null);
  const btnFloorG = useRef(null);
  const btnFloorB = useRef(null);
  const labelFloor2 = useRef(null);
  const labelFloor1 = useRef(null);
  const labelFloorG = useRef(null);
  const labelFloorB = useRef(null);
  const floorMap = {
    '2': [btnFloor2, labelFloor2],
    '1': [btnFloor1, labelFloor1],
    'G': [btnFloorG, labelFloorG],
    'B': [btnFloorB, labelFloorB],
  };
  const floorLabels = ['B','G','1','2'];

  const prevTarget = useRef(null); // NEW: Ref to track previous valid targetLevel

  // Define handleLogout
  const handleLogout = async () => {
    try {
      await api.post('/logout');
      setIsAuthenticated(false);
    } catch (error) {
      console.error('Logout error:', error);
      setIsAuthenticated(false); // Still log out on client even if server fails
    }
  };

  const sendHeartbeat = useCallback(async () => {
    try {
      await api.post('/heartbeat');
    } catch (error) {
      console.error('Error sending heartbeat:', error);
    }
  }, []);

  // Function to update button states based on lift status
  const updateButtonsBasedOnLiftStatus = useCallback(() => {
    const isMoving = status.up || status.down;
    
    // Update all floor buttons
    for (const floorStr in floorMap) {
      const floorData = floorMap[floorStr];
      const btnRef = floorData[0].current;
      const isSelected = floorStr === selectedFloor;
      
      if (btnRef) {
        if (isMoving) {
          if (isSelected) {
            // Selected button stays blue but darker when lift is moving
            btnRef.style.backgroundColor = '#eee';
            btnRef.style.borderColor = '#dd3333'; // red
          } else {
            // Non-selected buttons become dark gray
            btnRef.style.backgroundColor = '#555'; // Dark gray
            btnRef.style.borderColor = '#777'; // Dark gray border
          }
          btnRef.style.cursor = 'not-allowed';
          btnRef.disabled = true;
        } else {
          if (isSelected) {
            // Selected button is bright blue when lift is not moving
            btnRef.style.backgroundColor = '#eee';
            btnRef.style.borderColor = '#2196f3'; // Bright blue
          } else {
            // Non-selected buttons are normal gray
            btnRef.style.backgroundColor = '#888';
            btnRef.style.borderColor = '#bababa';
          }
          btnRef.style.cursor = 'pointer';
          btnRef.disabled = false;
        }
      }
    }
  }, [status.up, status.down, selectedFloor]);

  // Function to fetch lift status
  const fetchStatus = useCallback(async () => {
    try {
      const response = await api.get('/status');
      setStatus(response.data);
      setPosition(response.data.currentPosition || "Unknown");
      setSettingsState(response.data.settings); // NEW: Update settings state
      setError('');
    } catch (error) {
      console.error('Error fetching status:', error);
      setError('Error reaching lift server');
    }
  }, []);

  // Effect for polling lift status
  useEffect(() => {
    fetchStatus();
    const intervalId = setInterval(fetchStatus, 250); // Poll every .25 seconds
    return () => clearInterval(intervalId);
  }, [fetchStatus]);

  // Effect for heartbeat
  useEffect(() => {
    const heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
    return () => clearInterval(heartbeatInterval);
  }, [sendHeartbeat]);

  // Effect for background animation
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const animate = () => {
      positionBgY += (status.up ? 0.5 : (status.down ? -0.5 : 0));
      container.style.backgroundPositionY = `${positionBgY}px`;
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, [status.up, status.down]);

  // Effect for updating buttons on status change
  useEffect(() => {
    updateButtonsBasedOnLiftStatus();
  }, [updateButtonsBasedOnLiftStatus]);

  // Effect to update buttons on mode change to 'home'
  useEffect(() => {
    if (mode === 'home') {
      updateButtonsBasedOnLiftStatus();
    }
  }, [mode, updateButtonsBasedOnLiftStatus]);

  // Effect to synchronize selectedFloor based on current status
  useEffect(() => {
    if (status.manual) {
      setSelectedFloor(null);
    } else if (status.targetLevel && status.targetLevel !== 'none') {
      setSelectedFloor(status.targetLevel);
    } else if (!status.up && !status.down && ['B', 'G', '1', '2'].includes(status.currentPosition)) {
      setSelectedFloor(status.currentPosition);
    } else {
      setSelectedFloor(null);
    }
  }, [status.manual, status.targetLevel, status.up, status.down, status.currentPosition]);

  // Effect for toggling home/settings buttons
  useEffect(() => {
    if (showHomeButtonRef.current) showHomeButtonRef.current.style.display = mode === 'settings' ? 'flex' : 'none';
    if (showSettingsButtonRef.current) showSettingsButtonRef.current.style.display = mode === 'home' ? 'flex' : 'none';
  }, [mode]);

  // Functions for floor selection
  const goToFloor = async (floor) => {
    try {
      await api.post('/floor', { floor });
      setSelectedFloor(floor);
    } catch (error) {
      console.error('Error going to floor:', error);
      setError('Error going to floor');
    }
  };

  const goToFloor2 = () => goToFloor('2');
  const goToFloor1 = () => goToFloor('1');
  const goToFloorG = () => goToFloor('G');
  const goToFloorB = () => goToFloor('B');

  // Function to stop the lift
  const stopLift = async () => {
    try {
      await api.post('/stop');
    } catch (error) {
      console.error('Error stopping lift:', error);
      setError('Error stopping lift');
    }
  };

  // Navigation functions
  const navHome = () => setMode('home');
  const navSettings = () => setMode('settings');

  return (
    <div className="lift-control" ref={containerRef}> {/* Reverted class to "lift-control" */}
      {/* Alerts under the title, as an overlay that does not push the page down. Stacked: red error text first, then banners */}
      <div className="top-alerts">
        {error && <div className="error">{error}</div>} {/* Reverted class to "error" */}
        {settingsState.maintenance && settingsState.maintenance.enabled && (
          <div className='banner maintenance-banner'>
            IGNORE SENSORS ON - door alerts and lock checks off {/* auto-off time is shown in the note under the Doors toggle */}
          </div>
        )}
        {status.fault && (
          <div className='banner fault-banner'>
            FAULT: {status.fault.reason} - floor calls blocked until the board is back
          </div>
        )}
      </div>
      <div className="menu-bar"> {/* Added back menu-bar */}
        <h1>LIFT CONTROL</h1>
        {!authDisabled && ( // FIXED: Hide logout if auth disabled
          <button className="logout-btn" onClick={handleLogout}>Logout</button>
        )}
      </div>
      {/* Removed manual-controls div - now in Settings.js */}
      {mode === 'home' ? (
        <div className="home-container" ref={showHomeRef}>
        
          <table className='level-selector'>
            <tbody>
              <tr className='level-wrapper'>
                <td><input id='lvl2' type="button" className='level-radio' onClick={goToFloor2} ref={btnFloor2} /></td>
                <td><label className='level-label' ref={labelFloor2} htmlFor='lvl2' style={position.includes('2') ? { fontWeight: 'bold', color: '#2196f3', fontSize: '3.5rem', textShadow: '0 0 15px rgba(160,240,255,0.95)' } : { fontWeight: 'bold', color: '#000', fontSize: '3.5rem', textShadow: '0 0 5px rgba(33,150,243,0)' }}>2</label></td>
              </tr>
              <tr className='level-wrapper'>
                <td><input id='lvl1' type="button" className='level-radio' onClick={goToFloor1} ref={btnFloor1} /></td>
                <td><label className='level-label' ref={labelFloor1} htmlFor='lvl1' style={position.includes('1') ? { fontWeight: 'bold', color: '#2196f3', fontSize: '3.5rem', textShadow: '0 0 15px rgba(160,240,255,0.95)' } : { fontWeight: 'bold', color: '#000', fontSize: '3.5rem', textShadow: '0 0 5px rgba(33,150,243,0)' }}>1</label></td>
              </tr>
              <tr className='level-wrapper'>
                <td><input id='lvlG' type="button" className='level-radio' onClick={goToFloorG} ref={btnFloorG} /></td>
                <td><label className='level-label' ref={labelFloorG} htmlFor='lvlG' style={position.includes('G') ? { fontWeight: 'bold', color: '#2196f3', fontSize: '3.5rem', textShadow: '0 0 15px rgba(160,240,255,0.95)' } : { fontWeight: 'bold', color: '#000', fontSize: '3.5rem', textShadow: '0 0 5px rgba(33,150,243,0)' }}>G</label></td>
              </tr>
              <tr className='level-wrapper'>
                <td><input id='lvlB' type="button" className='level-radio' onClick={goToFloorB} ref={btnFloorB} /></td>
                <td><label className='level-label' ref={labelFloorB} htmlFor='lvlB' style={position.includes('B') ? { fontWeight: 'bold', color: '#2196f3', fontSize: '3.5rem', textShadow: '0 0 15px rgba(160,240,255,0.95)' } : { fontWeight: 'bold', color: '#000', fontSize: '3.5rem', textShadow: '0 0 5px rgba(33,150,243,0)' }}>B</label></td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <Settings 
          settings={settingsState} 
          onUpdate={setSettingsState} 
          targetLevel={status.targetLevel || null} 
          position={position}
        />
      )}
      <div className='nav-wrapper'>
        <button className='stop-btn' onClick={stopLift}>
          <StopImg />
        </button>
        <label className='level-label' style={{ fontWeight: 'bold', margin: '0 .3em', color: '#333', fontSize: '1.5rem', textShadow: '0px 0px 4px #28d' }}>
          {status.displayMessage!="Idle" ? status.displayMessage : ""}
        </label>
        <button className='home-btn' onClick={navHome} ref={showHomeButtonRef}>
          <HomeImg />
        </button>
        <button className='settings-btn' onClick={navSettings} ref={showSettingsButtonRef}>
          <SettingsImg />
        </button>
      </div>
      {/*status.currentPosition && ( // Display current levels for debugging
        <div className="current-level">
          {JSON.stringify(status)}
          {selectedFloor}
        </div>
      )*/}
    </div>
  );
}

export default LiftControl;