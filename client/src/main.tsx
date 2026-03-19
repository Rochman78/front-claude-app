import React from 'react';
import ReactDOM from 'react-dom/client';
import { FrontContextProvider } from './providers/FrontContext';
import App from './App';
import './styles/plugin.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FrontContextProvider>
      <App />
    </FrontContextProvider>
  </React.StrictMode>,
);
