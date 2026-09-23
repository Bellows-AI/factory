import { JOB_LABEL, LEASE_LABEL } from './labels.js';
import { randomUUID } from 'node:crypto';
import type { BoardJob } from './board.js';
import { envFileBody } from './claim.js';
import { lookupHelper, parseHelperOutput } from './helpers.js';
import type { HelperPlan, HelperResult } from './helpers.js';
import { helperEnvSecretName, helperJobName, helperJobSpec, jobPath, secretsPath } from './k8s-auxspec.js';
import { envBodyToData, jobsPath } from './k8s-podspec.js';
import { helperVerdict } from './k8s-poll.js';
import { ERROR_PREVIEW_CHARS, HTTP_ERROR_STATUS } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';
import { withPublishToken } from './publish.js';

/**
 * The kubernetes transport for one block-helper step (issue #207): an aux Job over the workspaces
 * PVC, the same entrypoint/argv/script-content shape `publishGit` (k8s-runner.ts) runs its steps
 * with — an attempt-scoped Secret only when the helper writes to GitHub (`plan.githubWriting`),
 * the bounded input as a literal pod-spec env value (never a credential), and cleanup of both on
 * every exit path. Unknown helper ids fail BEFORE any Job is created, matching the docker
 * transport's own first check. Split out of `k8s-runner.ts` purely to keep that file under
 * AGENTS.md's line-count budget.
 */
export async function runHelper(deps: K8sDeps, job: BoardJob, plan: HelperPlan, token?: string): Promise<HelperResult> {
    const descriptor = lookupHelper(plan.helperId);
    if (!descriptor) {
        return {
            ok: false,
            reason: 'unknown_helper',
            message: `no allowlisted helper is registered as "${plan.helperId}"`,
        };
    }
    // Minted fresh per call, never repeats — the same guarantee a lease token carries. A
    // `(job, plan)` hash alone would collide the moment a real producer ever declares two plans
    // of one phase naming the same helper (called twice with different input, say); the nonce
    // closes that hole without threading an index through the platform-neutral `runHelper` seam.
    const nonce = randomUUID();
    const env = plan.githubWriting ? envBodyToData(envFileBody(withPublishToken(job, token))) : {};
    const secret = Object.keys(env).length ? helperEnvSecretName(job, plan, nonce) : null;
    const jobName = helperJobName(job, plan, nonce);
    try {
        if (secret) {
            const response = await deps.request('POST', secretsPath(deps.config.k8sNamespace), {
                apiVersion: 'v1',
                kind: 'Secret',
                type: 'Opaque',
                metadata: { name: secret, labels: { [JOB_LABEL]: job.id, [LEASE_LABEL]: job.leaseToken } },
                stringData: env,
            });
            if (response.status >= HTTP_ERROR_STATUS) {
                return {
                    ok: false,
                    reason: 'runner_error',
                    message: `creating the helper secret answered ${response.status}: ${response.body.slice(0, ERROR_PREVIEW_CHARS)}`,
                };
            }
        }
        const created = await deps.request(
            'POST',
            jobsPath(deps.config.k8sNamespace),
            helperJobSpec(deps.config, job, { plan, descriptor, envSecret: secret, nonce })
        );
        if (created.status >= HTTP_ERROR_STATUS) {
            return {
                ok: false,
                reason: 'runner_error',
                message: `creating the helper job answered ${created.status}: ${created.body.slice(0, ERROR_PREVIEW_CHARS)}`,
            };
        }
        const verdict = await helperVerdict(deps, jobName);
        if (verdict.timedOut) {
            return { ok: false, reason: 'timeout', message: 'the helper job exceeded its deadline' };
        }
        if (verdict.exitCode !== 0) {
            return {
                ok: false,
                reason: 'runner_error',
                message: verdict.output.trim() || `the helper exited ${verdict.exitCode ?? 'without a readable code'}`,
            };
        }
        return parseHelperOutput(descriptor, verdict.output);
    } catch (e) {
        return { ok: false, reason: 'runner_error', message: (e as Error).message };
    } finally {
        void deps.request('DELETE', `${jobPath(deps.config.k8sNamespace, jobName)}?propagationPolicy=Background`).then(
            () => undefined,
            () => undefined
        );
        if (secret) {
            void deps.request('DELETE', `${secretsPath(deps.config.k8sNamespace)}/${secret}`).then(
                () => undefined,
                () => undefined
            );
        }
    }
}
