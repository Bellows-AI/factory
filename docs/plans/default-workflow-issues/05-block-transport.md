# [Workflow] Add allowlisted block-helper transport with Docker/Kubernetes parity

Parent: #36

Depends on #204. Merge after #202 because both touch the driver completion/loop contracts.

## Goal

Provide one generic, fenced way for an expanded built-in block node to run a board-owned helper before/after its agent run. Docker and Kubernetes must execute the same helper plan with the same credentials, bounds, and failure semantics.

This issue implements transport only. It must not contain review- or merge-specific branching.

## Work

- Consume the low-level block runtime metadata produced by #204's compiler. A runtime plan names an allowlisted helper ID plus validated/bounded JSON input; it never carries arbitrary shell or an image.
- Add a generic runner seam such as `runWorkflowHelper(job, plan, phase, token?)` with one shared result type.
- Keep helper lookup closed over real files in `driver/src/scripts/`. Unknown/unavailable helper IDs fail before any container/Job starts.
- Docker: execute the helper in the task worktree using the existing runner image, env-file secrecy, lease labels, output cap, and direct argv conventions.
- Kubernetes: execute the same entrypoint/argv/script content in an auxiliary Job on the task PVC, with attempt-scoped Secret, lease labels, bounded polling/logs, and cleanup.
- The loop owns when a declared pre/post helper runs, fences it with the same lease/stop state as sync/gates/publish, and reports a named failure without launching the agent when a required pre-helper fails.
- Ask for a fresh installation token immediately before a GitHub-writing helper; a read-only helper may use the claim env. Tokens never enter argv or output.
- Parse versioned bounded JSON only. Malformed, oversized, or wrong-version output is a helper failure, never agent context.
- Copy new script directories/files into `dist` as required by the driver package build.

## Ownership boundary

Own: generic driver/runner helper interfaces, loop integration, Docker/Kubernetes transports, shared parsing/bounds, parity tests, executor docs.

Do not touch: review/merge helper contents, workflow settings/jobs routes, webhook/wait store, web UI, or block-specific prompts/outcomes.

#122 and #133 must use this seam and must not add their own Docker/Kubernetes execution paths.

## Acceptance

- The same helper plan produces byte-equivalent argv/input and normalized result on both executors.
- Stop/lost lease prevents later helper/agent/publish work and cleans auxiliary resources.
- Unknown helpers, malformed output, auth failure, timeout, and oversized output have named bounded failures.
- Secrets are absent from argv, pod specs, logs, and stored output.
- A normal inline agent workflow pays no helper work and behaves unchanged.

## Verification

- Focused `driver/test/loop.test.ts`, `docker.test.ts`, `k8s.test.ts`, transport, and scripts suites.
- `npm run test:executors`
- `npm run test:coverage:executors`
- `npm run typecheck`
- `npm run lint`

