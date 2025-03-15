import React, { useState, useEffect } from 'react';
import axios from 'axios';
import LiftControl from './LiftControl';
import Login from './Login';
import './App.css';

// Create a single Axios instance for all API calls
export const api = axios.create({
  withCredentials: true // This enables cookies to be sent with requests
});
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if ((error.response.status === 403) && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        await api.post('/refresh-token');
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh token has failed, redirect to login
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }
    return Promise.reject(error);
  }
);

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // Try to refresh the token first if needed
        try {
          await api.post('/refresh-token');
        } catch (refreshError) {
          console.log('Token refresh failed or not needed');
        }
        
        // Then check authentication
        const response = await api.get('/check-auth');
        if (response.status === 200) {
          setIsAuthenticated(true);
        } else {
          setIsAuthenticated(false);
        }
      } catch (error) {
        console.error('Authentication check failed:', error);
        setIsAuthenticated(false);
      }
    };

    checkAuth();
  }, []);
  return (
    <div className="App">
      {isAuthenticated ? (
        <LiftControl setIsAuthenticated={setIsAuthenticated} />
      ) : (
        <Login setIsAuthenticated={setIsAuthenticated} />
      )}
    </div>
  );
}

export default App;
