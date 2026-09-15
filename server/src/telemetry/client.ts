import type { JobRun, TelemetryInput } from '@factory-ai/core';

export type TelemetrySource = 'postgres' | 'fixture' | 'off';

export interface TelemetryHealth {
    /**
     * 'empty' is deliberately distinct from 'unreachable': a wired-but-silent pipeline is the
     * normal state during setup, and collapsing the two makes it undiagnosable.
     */
    status: 'ok' | 'empty' | 'unreachable';
    reason: string | null;
}

/**
 * What one fetch of the store returns, cached as ONE snapshot: the session rollups every
 * figure aggregates over, and the organization's own run rows the per-task statistics
 * distribute over. One snapshot, one TTL — every range and every scope is a re-aggregation of
 * these two lists, never a second read.
 */
export interface TelemetryFetch {
    input: TelemetryInput;
    runs: JobRun[];
}

/**
 * The fixture implementation is selected by `TELEMETRY_SOURCE=fixture`;
 * the default is postgres, which needs a database but no collector.
 */
export interface TelemetryClient {
    fetchRollups(options?: { repos?: readonly string[]; since?: string }): Promise<TelemetryFetch>;
    /** Never throws — it is called on the degradation path. */
    health(): Promise<TelemetryHealth>;
}
