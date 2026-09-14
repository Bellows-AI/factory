import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { LoginGate } from './components/LoginGate.js';
import './styles.css';

// The gate wraps App rather than living inside it, so that App is never mounted for a caller who is
// not signed in: its very first render starts a poll of /api/stats, and a gate one level down would
// mean every unauthenticated visit fired a request that could only 401.
//
// The router sits OUTSIDE the gate, though, and the reason the gate is inside App does not extend to
// it: a router fetches nothing. Outside means the gate can read the location for its `returnTo`
// instead of reaching for window.location, and leaves room for a real /login route later.
createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <BrowserRouter>
            <LoginGate>
                <App />
            </LoginGate>
        </BrowserRouter>
    </StrictMode>
);
