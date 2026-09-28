import type { BoardJob } from './board.js';
import { JOB_LABEL, LEASE_LABEL, SERVICE_LABEL } from './labels.js';
import { networkName } from './services.js';
import { alreadyGone, linesOf, type ExecDocker } from './docker-runner-support.js';
import type { OrphanGroup, OrphanObject, ReaperArm } from './reaper.js';

/**
 * The docker half of the orphan reaper (issue #301): label-filtered `docker ps`, container
 * removal, and the per-attempt services network's teardown — the twin of `dockerServiceTeardown`
 * and the docker fence acting on fleets whose attempt can never tear itself down. Scope is the
 * SERVICE label only: the runner container is `--rm`ed by its own verdict path and swept by the
 * fence at the next claim; the service fleet is the part observed rotting.
 */

/**
 * Docker's `CreatedAt` spelling — `2026-09-14 10:00:00 +0000 UTC` — into epoch millis. Not a
 * RFC3339 string, so `Date.parse` alone would be gambling on the engine. Unparsable answers 0:
 * the board state has already decided the reap, and age only ever defers it — a format drift
 * would skip a grace window, nothing worse.
 */
export function parseDockerCreatedAt(raw: string): number {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2}) (?:[A-Z]+)$/.exec(raw.trim());
    if (!match) return 0;
    const [date, time, sign, oh, om] = match.slice(1) as [string, string, string, string, string];
    const offsetMinutes = Number(oh) * 60 + Number(om);
    const iso = `${date}T${time}${sign}${String(Math.floor(offsetMinutes / 60)).padStart(2, '0')}:${om}`;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/** One `docker ps --format '{{json .}}'` row the reaper can use, or null for junk. */
interface PsRow {
    id: string;
    jobId: string;
    leaseToken: string;
    createdAtMs: number;
}

/** The value of one k=v label in docker's comma-spelled `Labels` field. */
const labelOf = (labels: string, name: string): string | undefined => {
    const prefix = `${name}=`;
    const pair = labels.split(',').find((candidate) => candidate.startsWith(prefix));
    return pair?.slice(prefix.length);
};

const parsePsRow = (line: string): PsRow | null => {
    let fields: { ID?: unknown; Labels?: unknown; CreatedAt?: unknown };
    try {
        fields = JSON.parse(line) as typeof fields;
    } catch {
        return null;
    }
    if (typeof fields.ID !== 'string' || !fields.ID) return null;
    const labels = typeof fields.Labels === 'string' ? fields.Labels : '';
    const jobId = labelOf(labels, JOB_LABEL);
    const leaseToken = labelOf(labels, LEASE_LABEL);
    // The service label is the arm's scope: a runner container carries only the pair above, and
    // the fence — not the reaper — is what owns it. Checked here as well as in the argv filter,
    // because the argv is the daemon's instruction and this is the row's proof.
    const service = labelOf(labels, SERVICE_LABEL);
    if (!jobId || !leaseToken || !service) return null;
    const createdAtMs = typeof fields.CreatedAt === 'string' ? parseDockerCreatedAt(fields.CreatedAt) : 0;
    return { id: fields.ID, jobId, leaseToken, createdAtMs };
};

const scan = async (execDocker: ExecDocker): Promise<OrphanGroup[]> => {
    let stdout: string;
    try {
        stdout = (await execDocker(['ps', '-a', '--filter', `label=${SERVICE_LABEL}`, '--format', '{{json .}}']))
            .stdout;
    } catch {
        // The daemon answering nothing is not the daemon answering "nothing is orphaned".
        return [];
    }
    const groups = new Map<string, { ids: string[]; group: OrphanGroup }>();
    for (const line of stdout.split('\n')) {
        const row = parsePsRow(line.trim());
        if (!row) continue;
        const existing = groups.get(`${row.jobId}|${row.leaseToken}`);
        if (existing) {
            existing.ids.push(row.id);
            if (row.createdAtMs < existing.group.createdAtMs) existing.group.createdAtMs = row.createdAtMs;
        } else {
            groups.set(`${row.jobId}|${row.leaseToken}`, {
                ids: [row.id],
                group: {
                    jobId: row.jobId,
                    leaseToken: row.leaseToken,
                    createdAtMs: row.createdAtMs,
                    objects: [],
                },
            });
        }
    }
    // The objects are named by ID, not by container name: the id is what the removal argv
    // uses, and a name could address whatever owns it at removal time.
    return [...groups.values()].map(({ ids, group }) => ({
        ...group,
        objects: ids.map((id): OrphanObject => ({ kind: 'container', name: id })),
    }));
};

/** Removes a daemon object, reading its already-gone answer as success — the fence's tolerance. */
const removeTolerantly = async (execDocker: ExecDocker, args: string[]): Promise<boolean> => {
    try {
        await execDocker(args);
        return true;
    } catch (e) {
        if (alreadyGone(e)) return false;
        throw e;
    }
};

/**
 * The attempt's services network — attempt-scoped by name, so it can only ever resolve to this
 * dead attempt's own. A gate environment on its cooldown may still be attached, and docker
 * refuses to remove a network with an endpoint, so whatever is left is disconnected first — the
 * exact shape of the teardown this complements.
 */
const removeNetwork = async (execDocker: ExecDocker, network: string): Promise<boolean> => {
    try {
        const attached = await execDocker([
            'network',
            'inspect',
            '--format',
            '{{range .Containers}}{{println .Name}}{{end}}',
            network,
        ]);
        for (const name of linesOf(attached.stdout)) {
            await removeTolerantly(execDocker, ['network', 'disconnect', '-f', network, name]);
        }
    } catch {
        // Unreadable network is removed blind below; absence is the goal either way.
    }
    return removeTolerantly(execDocker, ['network', 'rm', network]);
};

const reap = async (execDocker: ExecDocker, group: OrphanGroup): Promise<readonly string[]> => {
    const removed: string[] = [];
    for (const object of group.objects) {
        if (await removeTolerantly(execDocker, ['rm', '-f', object.name])) {
            removed.push(`container ${object.name}`);
        }
    }
    if (group.leaseToken) {
        const network = networkName({ id: group.jobId, leaseToken: group.leaseToken } as BoardJob);
        if (await removeNetwork(execDocker, network)) removed.push(`network ${network}`);
    }
    return removed;
};

export function createDockerReaper(execDocker: ExecDocker): ReaperArm {
    return {
        scan: () => scan(execDocker),
        reap: (group) => reap(execDocker, group),
    };
}
