## 1. Driver: compose and thread the transcript path

- [x] 1.1 Add `transcriptDir(config, job)` in `driver/src/docker.ts` next to `runWorkingDir`: `<workspaceMount>/<workspacePath>/.factory/transcripts/<rootJobId>`, asserting `workspacePath` against `WORKSPACE_PATH` and `rootJobId` against `UUID` before interpolation; unit test the composition and both refusals (null workspace, non-uuid root)
- [x] 1.2 Thread `-e FACTORY_TRANSCRIPT_DIR=<value>` into `dockerArgs` when `cli === 'claude-code' && !remoteControl` (fresh runs and resumes alike); extend the pinned-argv test: env present for headless claude-code, absent for Remote Control and for opencode
- [x] 1.3 Twin in `driver/src/k8s.ts` `runnerJobSpec` env array under the same condition; extend the pod-spec pinning test with the same three cases

## 2. Reserved name, both sides

- [x] 2.1 Add `FACTORY_TRANSCRIPT_DIR` to `RESERVED_ENV_NAMES` in `driver/src/docker.ts`; run the driver suite (claimEnv filtering covers the new name)
- [x] 2.2 Add the name to the board's reserved list in `server/src/routes/env.ts`; run the reserved-name mirror test and a PUT-refusal case

## 3. Entrypoint: the guarded redirect

- [x] 3.1 In `docker/claude-executor/entrypoint.sh`, before the seed block: when `FACTORY_TRANSCRIPT_DIR` is set, `mkdir -p` it and `export CLAUDE_CONFIG_DIR` to it; refuse loudly when `TRUST_WORKDIR` is also set; POSIX sh only (`sh -n` clean, dash-compatible)
- [x] 3.2 Extend `driver/test/executor-images.test.ts` to pin the redirect block's presence and shape (the suite already pins baked scripts against drift); verify `bash docker/claude-executor/test.sh` still passes if it builds the image locally, otherwise keep to the script-content pinning

## 4. Docs

- [x] 4.1 Document the transcript store in `docs/jobs.md`: the layout (`<workspacePath>/.factory/transcripts/<rootJobId>/`), what persists (headless claude-code now, opencode sqlite, RC auth volume), the headless-resume side effect, and the out-of-scope list (analysis, retention, RC pile)
- [x] 4.2 Note the env and the guard in `docker/claude-executor/README.md` (what the entrypoint does when `FACTORY_TRANSCRIPT_DIR` is set, and the TRUST_WORKDIR refusal)

## 5. Verification sweep

- [x] 5.1 `npm run typecheck && npm run lint && npm test` green across the four packages
- [ ] 5.2 `npm run test:jobs` end-to-end (stub runners exercise the real driver loop; the new env rides argv harmlessly for stub images) and `npm run test:k8s` phase one (chart/template assertions) green — BLOCKED: `test:k8s` phase one green (34/34); `test:jobs` cannot run here (no docker daemon and no docker CLI in this environment); the offline driver suites that pin the argv it exercises are green
