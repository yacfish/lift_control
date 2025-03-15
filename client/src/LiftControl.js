import React, { useState, useEffect, useCallback, useRef } from 'react';
import './LiftControl.css';

import {ReactComponent as StopImg} from './images/stop.svg';
import {ReactComponent as HomeImg} from './images/home.svg';
import {ReactComponent as SettingsImg} from './images/settings.svg';

// Import the API instance from App.js
import { api } from './App';

let positionBgY = 0;

function LiftControl({ setIsAuthenticated }) {
  const [status, setStatus] = useState({ up: false, down: false, currentPosition: '', displayMessage: 'Idle' }); 
  const [mode, setMode] = useState('home');
  const [error, setError] = useState('');
  const [selectedFloor, setSelectedFloor] = useState(null); // Track the currently selected floor
  const [position, setPosition] = useState("Unknown"); // Track the current lift position
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
  }, [status.up, status.down, floorMap, selectedFloor]);

  useEffect(() => {
    const fetchStatus = async () => {
      // console.log('fetchStatus called'); // Log when fetchStatus is called
      try {
        const response = await api.get('/status');
        // console.log('fetchStatus response:', response); // Log the response
        const moving = response.data.up || response.data.down;
        const direction = response.data.up ? 'up' : response.data.down ? 'down' : 'none';
        if (moving) {
          stopAnimation();
          animateBackground(direction);
          if(!response.data.currentPosition.includes('-'))setSelectedFloor(response.data.targetLevel)
        } else {
          stopAnimation();
          if(!response.data.currentPosition.includes('-')){
            setSelectedFloor(response.data.currentPosition)
            // console.log('selectedFloor while stopped: ',response.data.currentPosition)
          }
        }
        setStatus(response.data); 
        setError('');
       
      } catch (error) {
        console.error('fetchStatus error:', error); // Log the error
        setError('Error fetching lift status. Please try again.');
      }
    };

    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 100);
    const heartbeatInterval = setInterval(sendHeartbeat, 1000);

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      clearInterval(statusInterval);
      clearInterval(heartbeatInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [sendHeartbeat]);

  // Update button states whenever status changes
  useEffect(() => {
    updateButtonsBasedOnLiftStatus();
  }, [status, updateButtonsBasedOnLiftStatus]);
  
  // Update position
  useEffect(() => {
    if (status.currentPosition) {
      setPosition(status.currentPosition);
    }
  }, [status.currentPosition]);

  const handleVisibilityChange = () => {
    if (document.hidden) {
      sendHeartbeat();
    }
  };

  const handleBeforeUnload = () => {
    navigator.sendBeacon('/heartbeat');
  };
  const animateBackground = (direction) => {
    
    const step = direction === 'up' ? .3 : -.3;

    const animate = () => {
      positionBgY += step;
      
      if (containerRef.current) {
        containerRef.current.style.backgroundPosition = `center ${positionBgY}%`;
      }
      animationRef.current = requestAnimationFrame(animate);
    };

    animate();
  };

  const stopAnimation = () => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
  };

  const handleToggle = async (direction) => {
    try {
      const newState = !status[direction];
      await api.post('/control', { direction, state: newState });
      setSelectedFloor(null);
      // setStatus(prev => ({ ...prev, [direction]: newState, [direction === 'up' ? 'down' : 'up']: false }));
      setError('');
      // console.log('newState',newState,'— direction', direction)
      // > newState false — direction up
      // > newState true — direction down
      
    } catch (error) {
      setError('Error controlling the lift. Please try again.');
      console.error('Error controlling lift:', error);
    }
  };
  
  const handleLogout = async () => {
    try {
      await api.post('/logout');
      setIsAuthenticated(false);
    } catch (error) {
      console.error('Error logging out:', error);
    }
  };
  const navHome = ()=>{
    // console.log('navHome')
    setMode('home')
    if (showSettingsRef.current) {
      showSettingsRef.current.style.display = 'none';
    }
    if (showHomeRef.current) {
      showHomeRef.current.style.display = 'flex';
    }
    if (showSettingsButtonRef.current) {
      showSettingsButtonRef.current.style.display = 'flex';
    }
    if (showHomeButtonRef.current) {
      showHomeButtonRef.current.style.display = 'none';
    }
  }
  const navSettings = ()=>{
    // console.log('navSettings')
    setMode('settings')
    if (showSettingsRef.current) {
      showSettingsRef.current.style.display = 'flex';
    }
    if (showHomeRef.current) {
      showHomeRef.current.style.display = 'none';
    }
    if (showSettingsButtonRef.current) {
      showSettingsButtonRef.current.style.display = 'none';
    }
    if (showHomeButtonRef.current) {
      showHomeButtonRef.current.style.display = 'flex';
    }
  }
  const goToFloor = (requestedFloor) => {
    // Update selected floor state
    setSelectedFloor((requestedFloor === '-' && position.includes('-')) ? null : requestedFloor);
    
    for (const floorStr in floorMap){
      const floorData = floorMap[floorStr]
      const btnRef = floorData[0].current
      // const labelRef = floorData[1].current
      if (btnRef){
        if (floorStr === requestedFloor){
          btnRef.style.backgroundColor='#eee'
          btnRef.style.borderColor='#2196f3'
        } else {
          btnRef.style.backgroundColor='#888'
          btnRef.style.borderColor='#bababa'
        }
      }
    }
    if (requestedFloor==='-')return
    // console.log('floor', requestedFloor)
    api.post('/floor', { floor: requestedFloor });
  }
  const goToFloor2 = () => {
    goToFloor('2')
  }
  const goToFloor1 = () => {
    goToFloor('1')
  }
  const goToFloorG = () => {
    goToFloor('G')
  }
  const goToFloorB = () => {
    goToFloor('B')
  }
  const stopLift = () => {
    // console.log('STOP')
    api.post('/stop', {});
    goToFloor('-')
  }
  return (
    <div className="lift-control" ref={containerRef}>
      <div className="menu-bar">
        <h1>LIFT CONTROL</h1>
        <button className="logout-btn" onClick={handleLogout}>Logout</button>
      </div>
      {error && <span className="error">{error}</span>}
      <div className="toggle-container" ref={showSettingsRef}>
        <div className="toggle-wrapper">
          <label className="toggle">
            <span className="label" style={status.up?
              {textShadow: 'rgb(0 128 255) 0px 0px 8px'}:
              {textShadow: 'rgb(0 0 0) 0px 0px 0px'}}
              >UP</span>
            <input
              type="checkbox"
              checked={status.up}
              onChange={() => handleToggle('up')}
              disabled={status.down}
            />
            <span className="slider"></span>
          </label>
        </div>
        <div className="toggle-wrapper">
          <label className="toggle">
            <span className="label" style={status.down?
              {textShadow: 'rgb(0 128 255) 0px 0px 8px'}:
              {textShadow: 'rgb(0 0 0) 0px 0px 0px'}}
              >DOWN</span>
            <input
              type="checkbox"
              checked={status.down}
              onChange={() => handleToggle('down')}
              disabled={status.up}
            />
            <span className="slider"></span>
          </label>
        </div>
      </div>
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
      <div className='nav-wrapper'>
        <button className='stop-btn' onClick={stopLift}>
          <StopImg />
        </button>
        <label className='level-label' style={{ color: '#333', fontSize: '2.5rem', textShadow: '0px 0px 10px #fff' }}>
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
