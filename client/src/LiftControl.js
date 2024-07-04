import React, { useState, useEffect, useCallback, useRef } from 'react';
import './LiftControl.css';

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
    const statusInterval = setInterval(fetchStatus, 1000);
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
      // console.log('newState',newState,'— direction', direction)
      // > newState false — direction up
      // > newState true — direction down
      
    } catch (error) {
      setError('Error controlling the lift. Please try again.');
      console.error('Error controlling lift:', error);
    }
  };
  const Settings = ()=> (
    <div className="toggle-container">
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
  )
  const Home = ()=> (
    <div>
    </div>
  )
  const handleLogout = async () => {
    try {
      await api.post('/logout');
      setIsAuthenticated(false);
    } catch (error) {
      console.error('Error logging out:', error);
    }
  };
  const goHome = ()=>{
    console.log('goHome')
    setMode('home')
  }
  const goSettings = ()=>{
    console.log('goSettings')
    setMode('settings')
  }
  
  return (
    <div className="lift-control" ref={containerRef}>
      <div className="menu-bar">
        <h1>LIFT CONTROL</h1>
        <button className="logout-btn" onClick={handleLogout}>Logout</button>
      </div>
      {error && <p className="error">{error}</p>}
      {mode==='settings' && <Settings/>}
      {mode==='home' && <Home/>}
      <div className='home-wrapper'>
        <button className='home-btn' onClick={mode==='settings'?goHome:goSettings}>
        {mode==='settings' &&<HomeImg/>}
        {mode==='home' &&<SettingsImg/>}
        </button>
      </div>
    </div>
  );
}

export default LiftControl;