/**
 * The labels every runner-owned object carries — docker containers, networks and volumes, and
 * kubernetes pods, jobs, services and secrets alike. Orphan sweeps and re-claims find a job's
 * leftovers by them, so both executors must spell them identically.
 */
export const JOB_LABEL = 'factory.job';
export const LEASE_LABEL = 'factory.lease';
export const SERVICE_LABEL = 'factory.service';

/**
 * Kubernetes only: the attempt's service subdomain on each of its service pods — what the
 * attempt's one headless Service selects by, so the runner and gate pods (which share the lease
 * label) never join the fleet's DNS.
 */
export const FLEET_LABEL = 'factory.fleet';

/** The label a gate-env orphan sweep filters on — `docker ps --filter label=factory.gates`. */
export const GATE_LABEL = 'factory.gates';
