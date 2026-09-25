/**
 * The labels every runner-owned object carries — docker containers, networks and volumes, and
 * kubernetes pods, jobs, services and secrets alike. Orphan sweeps and re-claims find a job's
 * leftovers by them, so both executors must spell them identically.
 */
export const JOB_LABEL = 'factory.job';
export const LEASE_LABEL = 'factory.lease';
export const SERVICE_LABEL = 'factory.service';

/** The label a gate-env orphan sweep filters on — `docker ps --filter label=factory.gates`. */
export const GATE_LABEL = 'factory.gates';
