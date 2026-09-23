import type { JobRun, TelemetryInput } from '@factory-ai/core';
import type { TelemetryClient, TelemetryHealth } from '../src/telemetry/client.js';
import { sampleTelemetry } from './helpers-config.js';

export interface TelemetryStubOptions {
    rollups?: () => Promise<TelemetryInput>;
    /** The run rows one fetch returns beside the rollups; empty unless a test feeds some. */
    runs?: () => JobRun[];
    health?: () => Promise<TelemetryHealth>;
}

export interface TelemetryStub extends TelemetryClient {
    rollupCalls: number;
    healthCalls: number;
}

export function stubTelemetryClient(options: TelemetryStubOptions = {}): TelemetryStub {
    const stub: TelemetryStub = {
        rollupCalls: 0,
        healthCalls: 0,
        async fetchRollups() {
            stub.rollupCalls += 1;
            // The stub mirrors the real shape: ONE fetch returns both lists, and every range
            // and scope is served from re-aggregating them.
            return {
                input: options.rollups ? await options.rollups() : structuredClone(sampleTelemetry()),
                runs: options.runs ? options.runs() : [],
            };
        },
        async health() {
            stub.healthCalls += 1;
            if (options.health) return options.health();
            return { status: 'ok', reason: null };
        },
    };
    return stub;
}
