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

/**
 * The declared hardening opt-out (issue #382), on the one pod that can carry it: a service whose
 * `.bellows.yaml` entry said `unhardened: true`. The driver already knows which pods those are —
 * the label exists for the ADMISSION POLICY, which sees only the object and must be able to tell
 * a declared opt-out from a driver that quietly stopped dropping capabilities. Its value is the
 * string `true` and nothing else; the policy matches on exactly that.
 */
export const UNHARDENED_LABEL = 'factory.unhardened';
