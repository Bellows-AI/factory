# Tasks: Scope runner volume mounts

## 1. Failing tests first

- [ ] 1.1 Extend the runner Job spec pins in `driver/test/` to require `subPath: <workspacePath>` on the runner's workspaces volumeMount, with both path segments asserted; verify the new assertions fail against the current `runnerJobSpec` (`npx vitest run driver/test`)
- [ ] 1.2 Add spec pins for every aux Job (gate, worktree sync, bellows readout, opencode readout, publish steps) requiring the same `subPath` on their volumeMounts; verify they fail
- [ ] 1.3 Add docker-parity pins: the runner and aux `docker run` argv carry `type=volume,…,volume-subpath=<orgId>/<userId>` for the workspaces mount; verify they fail
- [ ] 1.4 Add a malformed-`workspacePath` refusal test: a claim whose org or user segment fails the existing path assertions produces no pod spec / no docker argv; verify it fails (the assertion reuse does not exist yet)

## 2. Kubernetes executor

- [ ] 2.1 In `driver/src/k8s.ts`, add `subPath` to the runner's workspaces volumeMount, derived from the claim's `workspacePath` through the same segment assertions `runWorkingDir` uses; make 1.1 and 1.4 (k8s half) pass
- [ ] 2.2 Add `subPath` to every aux Job's workspaces volumeMount in `driver/src/k8s.ts`; make 1.2 pass

## 3. Docker executor parity

- [ ] 3.1 In `driver/src/docker.ts`, switch the runner and aux workspaces mounts to `--mount type=volume,src=<volume>,volume-subpath=<workspacePath>,target=<mount>`; make 1.3 and 1.4 (docker half) pass

## 4. Boundary behavior tests

- [ ] 4.1 Add the loud-failure test: a missing subPath target yields a pod spec whose mount names the absent directory (kubelet refuses) and, on docker, a mount that errors — no fallback to a broader mount; verify it passes against the implementation
- [ ] 4.2 Add the provisioning-ordering test: `ensureUserWorkspace` creates `<root>/<orgId>/<userId>` before a claim can carry that `workspacePath` (board-side `hasWorkspaces` gate), pinning D5; verify it passes

## 5. Docs

- [ ] 5.1 Update `docs/security.md`: the "isolation is a path… a boundary against accident" paragraph becomes a kernel-enforced mount boundary; state the dashboard's whole-volume access as the provisioning and org-level-analysis exception
- [ ] 5.2 Update `docs/kubernetes.md`: executor-table workspace row, a subPath paragraph (expansion caveat, loud-failure mode), and the unchanged-chart note
- [ ] 5.3 Update the docker/dev docs with the docker ≥ 26.1 floor for `volume-subpath`

## 6. Full verification

- [ ] 6.1 `npm test`, `npm run typecheck`, `npm run lint` green; `npm run test:k8s` phase one green (helm templates untouched)
- [ ] 6.2 Manual spot-check on a local cluster (`test:k8s --cluster` if available): a runner pod's mount root is the member's subtree and no sibling path resolves inside the container
