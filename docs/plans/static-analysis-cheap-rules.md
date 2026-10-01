# Static analysis: the cheap rules

Status: proposed. Follows the shared-literal constants and `lint/no-shared-literals.grit` ban.

Goal: turn on the compiler flags and Biome rules that enforce DRY/YAGNI and catch real bugs, at a
hit count small enough to fix in the same change. Per AGENTS.md, a rule lands only together with
the source change that clears its hits, never as a warning to be fixed later.

Hit counts were measured on `d97cf1d` with `npx biome lint --only=<group/rule> .` and
`npx tsc -p <pkg> --noEmit --<flag>`. Re-measure before starting; the tree moves.

## 1. TypeScript flags (`tsconfig.base.json`)

| Flag | Hits | Notes |
| --- | --- | --- |
| `noUnusedLocals` | 0 | Overlaps Biome's `noUnusedVariables`; also covers unused type-level locals. |
| `noUnusedParameters` | 2 (driver) | Fix the two; `_`-prefix only where a signature is fixed by a caller. |
| `noImplicitReturns` | 1 (driver) | Fix the one path. |
| `noFallthroughCasesInSwitch` | 0 | Free. |
| `noImplicitOverride` | 0 | Free. |

Verify: `npm run typecheck` (which includes `server/tsconfig.test.json`, so the test suites are
held to the same flags).

## 2. Biome rules (`biome.json`)

| Rule | Hits | What it buys |
| --- | --- | --- |
| `correctness/noUnusedFunctionParameters` (currently `off`) | 16 | YAGNI: parameters nothing reads. Delete them and update callers. |
| `suspicious/noUnnecessaryConditions` | 34 | Dead branches the types already rule out. Each one is either dead code (delete) or a type that is too wide (narrow it). Decide per site; do not suppress. |
| `nursery/useExhaustiveSwitchCases` | 1 | A new union member cannot be silently missed in a `switch`. |
| `nursery/noFloatingPromises` | 2 | Unhandled promise rejections. Real bugs, not style. |
| `nursery/noMisusedPromises` | 19 | Promises passed where a sync value is expected (conditions, `void` callbacks). Real bugs. |
| `style/noUnusedTemplateLiteral` | 22 | Backtick strings with no interpolation. Autofixable. |
| `complexity/noUselessStringConcat` | 3 | Autofixable. |
| `nursery/useStringStartsEndsWith` | 3 | Autofixable. |
| `style/noRestrictedImports` | 0 | Makes a lint rule of the driver's no-core boundary (AGENTS.md "Build coupling"). Configure `@factory-ai/core` as restricted under an override for `driver/**`. Today, only the missing tsconfig reference enforces it. |

Nursery rules are type-aware and may change between Biome releases; pin behavior with the
existing `core/test/biome.test.ts` if the config shape is asserted there.

## 3. `style/noProcessEnv`: one place reads the environment

~100 hits, most in tests and in driver container scripts. Enable it, with an override that allows
it only where env is the intended input channel:

- `server/src/config.ts`, `driver/src/config.ts`: the config loaders.
- `driver/src/scripts/**`: container scripts receive their parameters as env values by design
  (AGENTS.md "Container scripts are files").
- Test directories.
- `web/vite.config.ts`: build tooling.

The remaining non-test source hits get moved behind the config loaders:

| File | Hits |
| --- | --- |
| `server/src/seed/cli.ts` | 3 |
| `server/src/main.ts` | 1 |
| `server/src/workspace/reconcile.ts` | 1 |
| `driver/src/index.ts` | 2 |
| `driver/src/k8s-transport.ts` | 1 |

Each one becomes a field on `loadConfig()`'s result (server) or `DriverConfig` (driver). Per
AGENTS.md executor parity, a driver field has to work under both `EXECUTOR=docker` and
`EXECUTOR=kubernetes`. Read docs/configuration.md first.

## Order

1. TS flags. Smallest, no judgment calls.
2. Autofixable Biome rules (`noUnusedTemplateLiteral`, `noUselessStringConcat`,
   `useStringStartsEndsWith`) via `npm run lint:fix`, then review the diff.
3. `noFloatingPromises`, `noMisusedPromises`, `useExhaustiveSwitchCases`. Bug fixes; each gets a
   test if it changes behavior.
4. `noUnusedFunctionParameters`, `noUnnecessaryConditions`. Per-site judgment.
5. `noRestrictedImports` boundary.
6. `noProcessEnv` and the config moves.

One commit per step. Each step must leave `npm run typecheck`, `npm run lint` and `npm test`
green.

## Considered and rejected

| Rule | Hits | Why not |
| --- | --- | --- |
| `style/useNamingConvention` | 1529 | Churn with no bug class behind it. |
| `suspicious/useAwait` | 297 | Many `async` functions keep the signature on purpose (interface conformance). |
| `suspicious/noEmptyBlockStatements` | 129 | Mostly deliberate `catch {}` on best-effort paths. |
| TS `noPropertyAccessFromIndexSignature` | 267 | Fights the bracket-access house style for raw JSON (`otlp.ts`). |
| `security/noSecrets` | 131 | Entropy heuristic; mostly false positives. |
| `performance/noBarrelFile`, `noReExportAll` | 2 / 10 | `core/src/index.ts` is a barrel by contract (AGENTS.md). |

## Out of scope here

`knip` (unused exports, files, deps) and `jscpd` (copy-paste detection). Both need new pinned
devDependencies and were not measured. That is a separate decision.
