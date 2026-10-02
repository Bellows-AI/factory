import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const makefile = readFileSync(join(root, 'Makefile'), 'utf8');
const chart = readFileSync(join(root, 'charts', 'factory-local-state', 'templates', 'postgres.yaml'), 'utf8');

describe('make start preflight', () => {
    // The guard names a resource this repo no longer renders: the pre-#371 Deployment, which was
    // called `<release>-timescale`. Renaming it along with the chart makes the lookup miss, and the
    // destructive upgrade the guard exists to refuse proceeds silently.
    it('looks up the legacy timescale Deployment, not the current postgres name', () => {
        expect(makefile).toContain('get deployment/$(K8S_STATE_RELEASE)-timescale');
        expect(makefile).not.toContain('get deployment/$(K8S_STATE_RELEASE)-postgres');
    });

    it('describes the current claim with the name the chart actually mints', () => {
        expect(chart).toContain('{{ .Release.Name }}-postgres');
        expect(makefile).toContain('data-<release>-postgres-0');
    });
});
