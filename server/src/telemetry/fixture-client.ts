import { readFileSync } from 'node:fs';
import type { TelemetryInput } from '@factory-ai/core';
import type { TelemetryClient } from './client.js';
import { TelemetryError } from './errors.js';

const FIXTURE = new URL('../../../core/test/fixtures/telemetry-sessions.json', import.meta.url);

/**
 * Replays the committed synthetic sessions so the whole read path runs with no database and
 * no collector. This data is invented, so the UI is required to badge it
 * loudly — synthetic figures beside real figures is exactly the invented-number problem.
 */
export function createFixtureTelemetryClient(path: URL = FIXTURE): TelemetryClient {
    let cached: TelemetryInput | null = null;
    const load = () => {
        if (!cached) cached = JSON.parse(readFileSync(path, 'utf8')) as TelemetryInput;
        return cached;
    };

    return {
        async fetchRollups() {
            // Cloned because attribute() is handed the arrays directly and a caller mutating
            // them would silently poison every later request.
            return structuredClone(load());
        },
        async health() {
            return { status: 'ok', reason: null };
        },
    };
}

/**
 * TELEMETRY_SOURCE=off. Reports unreachable rather than throwing so the feature is absent
 * from the page instead of erroring on it.
 */
export function createNullTelemetryClient(): TelemetryClient {
    return {
        async fetchRollups(): Promise<TelemetryInput> {
            throw new TelemetryError('Telemetry is disabled (TELEMETRY_SOURCE=off)', 'UNREACHABLE');
        },
        async health() {
            return { status: 'unreachable', reason: 'Telemetry is disabled (TELEMETRY_SOURCE=off)' };
        },
    };
}
