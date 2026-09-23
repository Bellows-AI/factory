/**
 * The container scripts the driver ships: real files under `driver/src/scripts/`, read at load
 * time and passed to the container by content (`node -e`, `sh -c`, a git credential helper) —
 * never inline template strings in TS, and never by mounting a path (the driver talks to a remote
 * daemon or API server and has no host path into the volumes it names). Under tsx and vitest this
 * resolves into `src/scripts/`; in the built driver into `dist/scripts/`, where the build copies
 * the directory — forgetting THAT copy fails only in the container, the server/migrations trap.
 *
 * Executor-neutral: the docker and kubernetes runners hand the same bytes to their containers.
 * The run-time scripts live here; publish.ts, review.ts and services.ts load their own through
 * `containerScript`.
 */

import { readFileSync } from 'node:fs';

export const containerScript = (name: string): string =>
    readFileSync(new URL(`./scripts/${name}`, import.meta.url), 'utf8');
const script = containerScript;

/** The `sh -c` command that reads the Remote Control id out of a live transcript: see scripts/remote-session.sh. */
export const remoteSessionScript = script('remote-session.sh');

/** The close-time opencode readout: see scripts/opencode-readout.cjs. */
export const opencodeReadoutScript = script('opencode-readout.cjs');

/** The close-time claude-code turn count: see scripts/claude-turns.cjs. */
export const claudeTurnsScript = script('claude-turns.cjs');

/** The live cache probe: see scripts/opencode-cache-probe.cjs. */
export const opencodeCacheProbeScript = script('opencode-cache-probe.cjs');
