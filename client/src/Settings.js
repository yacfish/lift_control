// Settings.js
import React, { useState, useEffect } from 'react';
import { api } from './App';

const panelNames = ['Manual', 'Light', 'Doors', 'Call Buttons']; // Order: Manual (1), Light (2), Doors (3), Call Button (4)
function Settings({ settings, onUpdate, targetLevel, position }) { 
  const [currentPanelIndex, setCurrentPanelIndex] = useState(0);
  const [panelMounted, setPanelMounted] = useState(false);

  const navLeft = () => {
    setPanelMounted(false);
    setCurrentPanelIndex((prev) => (prev === 0 ? panelNames.length - 1 : prev - 1));
  };
  const navRight = () => {
    setPanelMounted(false);
    setCurrentPanelIndex((prev) => (prev === panelNames.length - 1 ? 0 : prev + 1));
  };

  const handleValueChange = async (section, key, enabled) => {
    try {
      await api.post(`/settings/${section}/${key}`, { value:enabled });
      onUpdate((prev) => ({ ...prev, [section]: { ...prev[section], [key]: enabled } }));
    } catch (error) {
      console.error('Error updating setting:', error);
    }
  };

  const handleAction = async (section, action) => {
    try {
      await api.post(`/settings/${section}/${action}`);
    } catch (error) {
      console.error('Error performing action:', error);
    }
  };

  useEffect(() => {
    setPanelMounted(false);
    const timer = setTimeout(() => setPanelMounted(true), 0);
    return () => clearTimeout(timer);
  }, [currentPanelIndex]);

  const renderPanel = () => {
    const name = panelNames[currentPanelIndex];
    switch (name) {
      case 'Manual': {
        const { upEnabled, downEnabled } = settings.manual;
        const isTargetActive = !!targetLevel && targetLevel !== 'none'; 
        return (
          <div className={`manual-controls ${panelMounted ? 'transitions-enabled' : ''}`}> 
            <div className="toggle-container">
              <label className="toggle">
                <span className="toggle-label">UP</span>
                <input 
                  type="checkbox" 
                  checked={upEnabled} 
                  disabled={isTargetActive || downEnabled || position === '2'}
                  onChange={(e) => handleValueChange('manual', 'up', e.target.checked)} 
                />
                <span className="slider"></span>
              </label>
            </div>
            <div className="toggle-container">
              <label className="toggle">
                <span className="toggle-label">DOWN</span>
                <input 
                  type="checkbox" 
                  checked={downEnabled} 
                  disabled={isTargetActive || upEnabled || position === 'B'}
                  onChange={(e) => handleValueChange('manual', 'down', e.target.checked)} 
                />
                <span className="slider"></span>
              </label>
            </div>
          </div>
        );
      }
      case 'Light': {
        const { auto, currentState, timeout } = settings.light;
        return (
          <div className={`panel light ${panelMounted ? 'transitions-enabled' : ''}`}>
            <div className="toggle-container">
              <label className="toggle">
                <span className="toggle-label">AUTO</span>
                <input type="checkbox" checked={auto} onChange={(e) => handleValueChange('light', 'auto', e.target.checked)} />
                <span className="slider"></span>
              </label>
            </div>
            <div className="toggle-container">
              <label className="toggle">
                <span className="toggle-label">SWITCH</span>
                <input type="checkbox" checked={currentState} disabled={auto} onChange={(e) => handleValueChange('light', 'switch', e.target.checked)} />
                <span className="slider"></span>
              </label>
            </div>
            <div className="toggle-container">
              <input type="text" value={timeout} onChange={(e) => handleValueChange('light', 'timeout', e.target.value)} />
              <span className="toggle-label-small">TIME OUT</span>
            </div>
          </div>
        );
      }
      case 'Doors': {
        const { auto } = settings.doors;
        const { allOpen, allLocked } = settings.doorStatuses || {}; // From status
        return (
          <div className={`panel doors ${panelMounted ? 'transitions-enabled' : ''}`}>
            <div className="toggle-container">
              <label className="toggle">
                <span className="toggle-label">AUTO</span>
                <input type="checkbox" checked={auto} onChange={(e) => handleValueChange('doors', 'auto', e.target.checked)} />
                <span className="slider"></span>
              </label>
            </div>
            <button 
              className="action-button"
              disabled={auto} 
              style={{ backgroundColor: auto ? '#ccc' : (allOpen ? '#f00' : '#2196f3') }} 
              onClick={() => handleAction('doors', 'open-all')}
            >
              OPEN ALL
            </button>
            <button 
              className="action-button"
              disabled={auto} 
              style={{ backgroundColor: auto ? '#ccc' : (allLocked ? '#f00' : '#2196f3') }} 
              onClick={() => handleAction('doors', 'lock-all')}
            >
              LOCK ALL
            </button>
          </div>
        );
      }
      case 'Call Buttons': {
        const { enabled } = settings.callButton;
        return (
          <div className={`panel call-buttons ${panelMounted ? 'transitions-enabled' : ''}`}>
            <div className="toggle-container">
              <label className="toggle">
                <span className="toggle-label">ENABLE</span>
                <input type="checkbox" checked={enabled} onChange={(e) => handleValueChange('call-buttons', 'enable', e.target.checked)} />
                <span className="slider"></span>
              </label>
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="settings-container">
      <div className="panel-nav">
        <button className="nav-arrow left" onClick={navLeft}>&lt;</button>
        <div className="panel-name">{panelNames[currentPanelIndex]}</div>
        <button className="nav-arrow right" onClick={navRight}>&gt;</button>
      </div>
      {renderPanel()}
    </div>
  );
}

export default Settings;