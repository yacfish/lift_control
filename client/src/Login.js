import React, { useState } from 'react';
import axios from 'axios';
import './Login.css';

function Login({ setIsAuthenticated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
  
    try {
      const response = await axios.post('/login', { username, password }, { withCredentials: true });
  
      // IMPORTANT: Get token and refresh token from the response
      const accessToken = response.data.token; // Assuming the server sends a 'token' field
      const refreshToken = response.data.refreshToken; // Assuming server also returns a refresh token
  
      // IMPORTANT: Store both tokens (access and refresh) in localStorage
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', refreshToken); //Also, take refreshToken just in case
  
      setIsAuthenticated(true); // Now set authentication state
      console.log('Login successful! Access Token saved.'); //Success message
    } catch (error) {
      if (error.response) {
        // Log the error
        console.log("Client log error status and data",error.response.status, error.response.data);
        setError(error.response.data.error || 'An error occurred during login');
      } else if (error.request) {
        setError('No response received from the server. Please try again.');
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <h2>Login</h2>
      <form name='login' onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={isLoading}>
          {isLoading ? 'Logging in...' : "let's go"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default Login;
