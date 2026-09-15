import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { telemetryStats } from '@factory-ai/core';
import { readFileSync } from 'node:fs';
import type { TelemetryInput, TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta, StatsPayload } from '../src/api/useStats.js';
import { AiUsagePanel } from '../src/panels/AiUsagePanel.js';
import { ByUserPanel } from '../src/panels/ByUserPanel.js';
import { TokenUsagePanel } from '../src/panels/TokenUsagePanel.js';
import { DataQualityPanel } from '../src/panels/DataQualityPanel.js';
import { tokens } from '../src/format.js';

/**
 * A render smoke test, not a UI test. It exists because the null-not-zero contract is only
 * real if it survives to the markup: everything upstream can be correct and a single `?? 0`
 * in a panel still puts "0 tokens" on the page next to a session nobody measured.
 *
 * react-dom/server needs no DOM, so this stays in the default offline suite.
 */

const REPO = 'Bellows-AI/bellows.ai';

const input = JSON.parse(
    readFileSync(new URL('../../core/test/fixtures/telemetry-sessions.json', import.meta.url), 'utf8')
) as TelemetryInput;

const NOW = new Date('2026-08-21T12:00:00.000Z');
const telemetry = telemetryStats(input, { repos: [REPO], now: NOW });
const empty = telemetryStats({ sessions: [], coverage: { from: null, to: null } }, { repos: [REPO], now: NOW });

const meta = (over: Partial<TelemetryMeta> = {}): TelemetryMeta => ({
    status: 'ok',
    reason: null,
    source: 'fixture',
    fetchedAt: NOW.toISOString(),
    ageSeconds: 0,
    stale: false,
    repoFilter: [REPO],
    otherRepoSessions: 1,
    sessionsWithoutHook: 1,
    ...over,
});

const render = (t: TelemetryStats, m: TelemetryMeta) =>
    [
        renderToStaticMarkup(<AiUsagePanel telemetry={t} meta={m} />),
        renderToStaticMarkup(<TokenUsagePanel telemetry={t} meta={m} />),
    ].join('\n');

describe('telemetry panels render', () => {
    it('renders real figures on the happy path', () => {
        const html = render(telemetry, meta());
        expect(html).toContain('synthetic fixture');
        expect(html).not.toContain('NaN');
        expect(html).not.toContain('Infinity');
        expect(html).not.toContain('undefined');
    });

    it('renders the by-user table with the attributed users and the unattributed line', () => {
        const html = renderToStaticMarkup(<ByUserPanel telemetry={telemetry} meta={meta()} />);
        expect(html).toContain('Usage by user');
        expect(html).toContain('alice');
        expect(html).toContain('Alice Doe');
        expect(html).toContain('bob');
        // The avatar renders only when the account carries one; bob's has none.
        expect(html).toContain('https://example.com/alice.png');
        expect(html).toContain('4 sessions ran with no matching board task');
        expect(html).not.toContain('NaN');
    });

    it('renders an all-null token group as an em dash, never a fabricated zero', () => {
        const unmeasured = telemetryStats(
            {
                sessions: [
                    {
                        ...input.sessions.find((s) => s.sessionId === 's01-token-heavy')!,
                        tokens: { input: null, output: null, cacheRead: null, cacheCreation: null },
                    },
                ],
                coverage: { from: null, to: null },
            },
            { repos: [REPO], now: NOW }
        );
        const html = renderToStaticMarkup(<ByUserPanel telemetry={unmeasured} meta={meta()} />);
        expect(html).toContain('<td>—</td>');
        expect(html).not.toContain('<td>0</td>');
    });

    it('says so when nothing can be attributed', () => {
        const html = renderToStaticMarkup(<ByUserPanel telemetry={empty} meta={meta()} />);
        expect(html).toContain('No sessions in the coverage window yet.');
    });

    it('renders five usage cards', () => {
        const html = renderToStaticMarkup(<AiUsagePanel telemetry={telemetry} meta={meta()} />);
        // Counted in the rendered markup rather than hard-coded: the card row is the page's
        // whole above-the-fold, and a dropped card would otherwise pass silently.
        expect(html.match(/class="card"/g)).toHaveLength(5);
    });

    it('renders em dashes, never zeros, on an empty store', () => {
        const html = render(empty, meta({ status: 'empty' }));
        expect(html).toContain('—');
        expect(html).not.toContain('NaN');
        expect(html).not.toContain('0 tokens');
        expect(html).toContain('No sessions in the coverage window yet');
    });

    it('renders billions as B rather than thousands of M', () => {
        // A real run reported 4.5e9 cache-read tokens, which rendered as "4543.89M".
        expect(tokens(4_543_894_453)).toBe('4.54B');
        expect(tokens(20_300_494)).toBe('20.3M');
        expect(tokens(null)).toBe('—');
    });

    it('renders a reason and no numbers when unreachable', () => {
        const html = render(empty, meta({ status: 'unreachable', reason: 'connection refused' }));
        expect(html).toContain('panel bad');
        expect(html).toContain('connection refused');
        expect(html).not.toContain('NaN');
    });

    it('surfaces both setup failures in data quality', () => {
        const payloadMeta: StatsPayload['meta'] = {
            fetchedAt: NOW.toISOString(),
            ageSeconds: 0,
            stale: false,
            organization: {
                mode: 'config',
                current: { id: 'x-org', name: 'X Org' },
                available: [{ id: 'x-org', name: 'X Org' }],
            },
            repos: [{ owner: 'x', name: 'y' }],
            range: { preset: 'all', from: null, to: null },
            telemetry: meta(),
        };
        const html = renderToStaticMarkup(<DataQualityPanel meta={payloadMeta} />);
        expect(html).toContain('agent-telemetry plugin');
        expect(html).toContain('happened in another repo');
        expect(html).toContain('synthetic fixture data');
    });

    it('renders no PR vocabulary anywhere', () => {
        const html = render(telemetry, meta());
        expect(html).not.toMatch(/pull request/i);
        expect(html).not.toContain('merged');
    });
});
