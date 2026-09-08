import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EnvVarsPanel } from '../src/panels/EnvVarsPanel.js';

/** The same contract panels.render.test.tsx pins: a placeholder never leaks into the markup. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

const noop = async () => null;

describe('the env vars panel', () => {
    it('offers an empty scope a way in', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel title="Core" hint="Injected into every runner." initialVars={[]} onSave={noop} />,
        );
        expect(html).toContain('Core');
        expect(html).toContain('No variables configured');
        expect(html).toContain('Add variable');
        expect(html).toContain('Save');
    });

    it('renders a row per variable with its name and value', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel
                title="My workspace"
                hint=""
                initialVars={[
                    { name: 'LOG_LEVEL', value: 'debug', isSecret: false, updatedAt: '2026-09-01T00:00:00.000Z' },
                ]}
                onSave={noop}
            />,
        );
        expect(html).toContain('LOG_LEVEL');
        expect(html).toContain('debug');
    });

    it('marks a secret as set and never renders a value for it', () => {
        // The server nulls a secret's value on every read, so "blank" is the truth the panel
        // renders — with the sentence that says what blank MEANS.
        const html = renderToStaticMarkup(
            <EnvVarsPanel
                title="Core"
                hint=""
                initialVars={[
                    { name: 'CORE_SECRET', value: null, isSecret: true, updatedAt: '2026-09-01T00:00:00.000Z' },
                ]}
                onSave={noop}
            />,
        );
        expect(html).toContain('CORE_SECRET');
        expect(html).toContain('secret');
        expect(html).toContain('leave blank to keep');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('masks a secret input, and locks the secret flag while the value is unknown', () => {
        // The panel never held the stored value, so unchecking "secret" would save an empty
        // string over a credential it cannot show — the one edit that must not be one click away.
        const html = renderToStaticMarkup(
            <EnvVarsPanel
                title="Core"
                hint=""
                initialVars={[
                    { name: 'CORE_SECRET', value: null, isSecret: true, updatedAt: '2026-09-01T00:00:00.000Z' },
                ]}
                onSave={noop}
            />,
        );
        expect(html).toContain('type="password"');
        expect(html).toContain('autoComplete="off"');
        expect(html).toContain('disabled');
    });

    it('renders a removed-only editor state without placeholders', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel
                title="Core"
                hint=""
                initialVars={[
                    { name: 'A', value: '1', isSecret: false, updatedAt: '2026-09-01T00:00:00.000Z' },
                    { name: 'B_SECRET', value: null, isSecret: true, updatedAt: '2026-09-01T00:00:00.000Z' },
                ]}
                onSave={noop}
            />,
        );
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('uses no form, because the CSP sends form-action none', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel title="Core" hint="" initialVars={[]} onSave={noop} />,
        );
        expect(html).not.toContain('<form');
    });
});
