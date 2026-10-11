import React from 'react';
import ReactDOM from 'react-dom/client';
// Inter, self-hosted from the npm package (no third-party font request). It registers the
// family as 'Inter Variable', which --font-sans in index.css names first. The explicit
// index.css path is what lets TypeScript type the side-effect import (vite/client's *.css).
import '@fontsource-variable/inter/index.css';
import { App } from '@/App';
import '@/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
