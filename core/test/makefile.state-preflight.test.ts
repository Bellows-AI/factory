import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `make start` upgrades the `factory-state` release in place and promises the re-run keeps its
 * data. Two state layouts break that promise rather than one, and both are invisible until after
 * the upgrade: the pre-#371 Deployment (whose standalone PVC helm deletes), and a StatefulSet
 * claim initialised before `PGDATA` named a subdirectory — postgres then `initdb`s a fresh,
 * empty cluster under `/var/lib/postgresql/data/pgdata` while the real one sits unused one
 * directory up, and the board comes back with an empty database and no error anywhere. Neither is
 * migrated: `state-preflight` refuses, and `make reset` is how the user asks for the delete.
 *
 * There is no way to exercise the recipe offline — it is kubectl against a cluster — so the guard
 * is pinned as text, the way this suite pins the chart and document invariants beside it.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const makefile = read('../../Makefile');
const kubernetes = read('../../docs/kubernetes.md');
const timescale = read('../../charts/factory-local-state/templates/timescale.yaml');

/** The `state-preflight` recipe: the target line through the last line that is still indented. */
const preflight = (() => {
    const lines = makefile.split('\n');
    const start = lines.findIndex((line) => line.startsWith('state-preflight:'));
    expect(start).toBeGreaterThan(-1);
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line !== '' && !line.startsWith('\t')) break;
        body.push(line);
    }
    return body.join('\n');
})();

describe('the factory-state upgrade preflight', () => {
    it('still refuses the pre-#371 Deployment', () => {
        expect(preflight).toContain('deployment/$(K8S_STATE_RELEASE)-timescale');
    });

    it('refuses a StatefulSet whose claim predates PGDATA', () => {
        expect(preflight).toContain('statefulset/$(K8S_STATE_RELEASE)-timescale');
        // The detection: the running container's env names, read back and searched for PGDATA.
        expect(preflight).toContain('.spec.template.spec.containers[*].env[*].name');
        expect(preflight).toMatch(/grep -qx ['"]?PGDATA/);
    });

    it('names `make reset` as the way through both refusals', () => {
        expect(preflight.match(/make reset/g) ?? []).toHaveLength(2);
    });

    it('guards the value the chart actually sets', () => {
        expect(timescale).toContain('value: /var/lib/postgresql/data/pgdata');
    });

    it('is documented where the Deployment refusal is', () => {
        expect(kubernetes).toContain('`make start` refuses a state claim initialised without `PGDATA`');
    });
});
