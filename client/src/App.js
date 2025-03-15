import React, { useState, useEffect } from 'react';
import axios from 'axios';
import LiftControl from './LiftControl';
import Login from './Login';
import './App.css';

/* export  */const api = axios.create({
  withCredentials: true
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
      // Retrieve token from localStorage
      const token = localStorage.getItem('accessToken');
       // If we've no token, return user to the login screen
       if (!token) {
          setIsAuthenticated(false)
          return;
        }
      try {
        // Set Auth Header before check authentication
        api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        const response = await api.get('/check-auth');
        if (response.status === 200) {
          setIsAuthenticated(true);
        } else {
          setIsAuthenticated(false);
        }
      } catch (error) {
        console.error('Authentication check failed:', error);
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
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