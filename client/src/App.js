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
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        await api.get('/check-auth');
        setIsAuthenticated(true);
      } catch (error) {
        console.error('Authentication check failed:', error);
      } finally {
        setIsLoading(false);
      }
    };
    checkAuth();
  }, []);

  if (isLoading) {
    return <div>Loading...</div>;
  }
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