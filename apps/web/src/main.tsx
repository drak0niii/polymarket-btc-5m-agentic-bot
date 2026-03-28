import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { BotStateProvider } from './hooks/useBotState';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BotStateProvider>
      <App />
    </BotStateProvider>
  </React.StrictMode>,
);
