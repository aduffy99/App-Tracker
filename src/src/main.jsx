import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

// Since this is a single file app with embedded Tailwind classes,
// we don't need a separate CSS import here, but this file is crucial
// for mounting the main React component.

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
