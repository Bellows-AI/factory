import { describe, expect, it } from 'vitest';
import { createFixtureTelemetryClient, createNullTelemetryClient } from '../src/telemetry/fixture-client.js';

describe('the fixture telemetry client', () => {
    it('replays the committed fixture without letting one caller poison the cached input', async () => {
        const client = createFixtureTelemetryClient();
        const first = await client.fetchRollups();
        const sessionCount = first.input.sessions.length;

        first.input.sessions.splice(0);
        const second = await client.fetchRollups();

        expect(sessionCount).toBeGreaterThan(0);
        expect(second.input.sessions).toHaveLength(sessionCount);
        expect(second.runs).toEqual([]);
        await expect(client.health()).resolves.toEqual({ status: 'ok', reason: null });
    });
});

describe('the disabled telemetry client', () => {
    it('reports an explicit unreachable state instead of manufacturing empty analytics', async () => {
        const client = createNullTelemetryClient();

        await expect(client.fetchRollups()).rejects.toMatchObject({
            name: 'TelemetryError',
            code: 'UNREACHABLE',
            message: 'Telemetry is disabled (TELEMETRY_SOURCE=off)',
        });
        await expect(client.health()).resolves.toEqual({
            status: 'unreachable',
            reason: 'Telemetry is disabled (TELEMETRY_SOURCE=off)',
        });
    });
});
