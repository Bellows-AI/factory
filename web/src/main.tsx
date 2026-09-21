import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App, appRoutes } from './App.js';
import { LoginGate } from './components/LoginGate.js';
import { ThemeProvider } from './theme.js';
import './styles.css';

// The gate wraps App rather than living inside it, so that App is never mounted for a caller who is
// not signed in: its very first render starts a poll of /api/stats, and a gate one level down would
// mean every unauthenticated visit fired a request that could only 401.
//
// The router sits OUTSIDE the gate, though, and the reason the gate is inside App does not extend to
// it: a router fetches nothing. Outside means the gate can read the location for its `returnTo`
// instead of reaching for window.location, and leaves room for a real /login route later. The gate
// is still the root ROUTE element, because useLocation needs router context.
//
// A data router (`createBrowserRouter`) rather than `<BrowserRouter>`: the settings area's
// unsaved-change guard (issue 182) blocks in-app navigation with `useBlocker`, which runs only
// inside one — a plain `<BrowserRouter>` throws the moment a layout calls it.
const router = createBrowserRouter([
    {
        element: (
            <LoginGate>
                <App />
            </LoginGate>
        ),
        children: appRoutes,
    },
]);

createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        {/* Above the router, so the appearance preference (issue 188) covers the public pages —
            the gate and onboarding — and the authenticated shell alike. */}
        <ThemeProvider>
            <RouterProvider router={router} />
        </ThemeProvider>
    </StrictMode>
);
