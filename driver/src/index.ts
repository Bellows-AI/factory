import { createBoard } from './board.js';
import { loadDriverConfig } from './config.js';
import { createDockerRunner } from './docker.js';
import { createKubernetesRunner, inClusterRequest } from './k8s.js';
import { createLoop } from './loop.js';

const config = loadDriverConfig(process.env);

const missing = config.passEnv.filter((name) => !process.env[name]);
if (missing.length === config.passEnv.length) {
    // Not fatal: an image with a login baked into a mounted volume needs none of these. Worth
    // saying out loud, because the alternative first symptom is every job failing at the CLI's
    // login prompt with an exit code and no explanation.
    console.warn(`[driver] none of ${config.passEnv.join(', ')} are set; runners will have no credential`);
}

const board = createBoard({
    url: config.boardUrl,
    leaseSeconds: config.leaseSeconds,
    token: config.boardToken,
});
// EXECUTOR picks the platform runners run on. `inClusterRequest()` is fatal here rather than on the
// first claim: a driver asked for kubernetes outside a cluster should say so at startup.
const runner =
    config.executor === 'kubernetes'
        ? createKubernetesRunner(config, inClusterRequest())
        : createDockerRunner(config);
const loop = createLoop({ board, runner, config, log: (m) => console.log(`[driver] ${m}`) });

// Stop claiming, then drain. A second signal is the escape hatch, since a drain waits for a job
// that may have half an hour left on it.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        if (stopping) {
            console.log('[driver] second signal, exiting now — runners are left to the lease');
            process.exit(1);
        }
        stopping = true;
        console.log('[driver] draining; signal again to exit immediately');
        loop.stop();
    });
}

await loop.start();
