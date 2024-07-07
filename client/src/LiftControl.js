import React, { useState, useEffect, useCallback, useRef } from 'react';
import './LiftControl.css';

import {ReactComponent as StopImg} from './images/stop.svg';
import {ReactComponent as HomeImg} from './images/home.svg';
import {ReactComponent as SettingsImg} from './images/settings.svg';

import {api} from './App';

let positionBgY = 0;

function LiftControl({ setIsAuthenticated }) {
  const [status, setStatus] = useState({ up: false, down: false });
  const [mode, setMode] = useState('home');
  const [error, setError] = useState('');
  const containerRef = useRef(null);
  const animationRef = useRef(null);
  const showSettingsRef = useRef(null);
  const showHomeRef = useRef(null);
  const showSettingsButtonRef = useRef(null);
  const showHomeButtonRef = useRef(null);
  const btnFloor2 = useRef(null)
  const btnFloor1 = useRef(null)
  const btnFloorG = useRef(null)
  const btnFloorB = useRef(null)
  const labelFloor2 = useRef(null)
  const labelFloor1 = useRef(null)
  const labelFloorG = useRef(null)
  const labelFloorB = useRef(null)
  const floorMap = {
    '2':[btnFloor2,labelFloor2],
    '1':[btnFloor1,labelFloor1],
    'G':[btnFloorG,labelFloorG],
    'B':[btnFloorB,labelFloorB],
  }

  const sendHeartbeat = useCallback(async () => {
    try {
      await api.post('/heartbeat');
    } catch (error) {
      console.error('Error sending heartbeat:', error);
    }
  }, []);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await api.get('/status');
        // console.log('STATUS response.data', response.data)
        const moving = response.data.up || response.data.down
        const direction = response.data.up? 'up':'down'
        if (moving) {
          stopAnimation();
          animateBackground(direction);
        } else {
          stopAnimation();
        }
        setStatus(response.data);
        setError('');
      } catch (error) {
        setError('Error fetching lift status. Please try again.');
        console.error('Error fetching status:', error);
      }
    };

    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 500);
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
      setStatus(prev => ({ ...prev, [direction]: newState, [direction === 'up' ? 'down' : 'up']: false }));
      setError('');
      console.log('newState',newState,'— direction', direction)
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
    console.log('navHome')
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
    console.log('navSettings')
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
    console.log('floor', requestedFloor)
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
    console.log('STOP')
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
          <tr className='level-wrapper'><td><input type="button" className='level-radio' onClick={goToFloor2} ref={btnFloor2}/></td><td><label className='level-label' ref={labelFloorB}>2</label></td></tr>
          <tr className='level-wrapper'><td><input type="button" className='level-radio' onClick={goToFloor1} ref={btnFloor1}/></td><td><label className='level-label' ref={labelFloorB}>1</label></td></tr>
          <tr className='level-wrapper'><td><input type="button" className='level-radio' onClick={goToFloorG} ref={btnFloorG}/></td><td><label className='level-label' ref={labelFloorB}>G</label></td></tr>
          <tr className='level-wrapper'><td><input type="button" className='level-radio' onClick={goToFloorB} ref={btnFloorB}/></td><td><label className='level-label' ref={labelFloorB}>B</label></td></tr>
        </table>
      </div>
      <div className='nav-wrapper'>
      <button className='stop-btn' onClick={stopLift}>
          <StopImg/>
        </button>
        <button className='home-btn' onClick={navHome} ref={showHomeButtonRef}>
          <HomeImg/>
        </button>
        <button className='settings-btn' onClick={navSettings} ref={showSettingsButtonRef}>
          <SettingsImg/>
        </button>
      </div>
    </div>
  );
}

export default LiftControl;