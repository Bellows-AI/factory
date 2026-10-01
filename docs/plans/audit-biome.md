# Biome rule audit — what else would catch real problems today

Biome 2.5.13, config `biome.json`, preset `recommended`, one plugin (`lint/no-shared-literals.grit`).
Every count below was measured with `npx biome lint --only=<group>/<rule> --reporter=json .` against the
tree at `d35cb78`. "non-test" = diagnostics outside `*/test/**`, `*/test-db/**`, `*.test.ts`.

---

## 1. Existing carve-outs: measured

AGENTS.md says every carve-out is a re-enable candidate. It is now measurable.

| Rule (currently `off`) | Hits | Non-test | Verdict |
| --- | ---: | ---: | --- |
| `complexity/noUselessFragments` | **0** | 0 | **Re-enable free.** The carve-out is stale. |
| `suspicious/noRedeclare` | **0** | 0 | **Re-enable free.** Stale. |
| `a11y/noSvgWithoutTitle` | **0** | 0 | **Re-enable free.** Stale (charts must have picked up titles). |
| `suspicious/noAssignInExpressions` | 1 | 1 | **Re-enable + fix.** `driver/src/k8s-gates.ts:213`. One line. |
| `suspicious/noImplicitAnyLet` | 1 | 0 | **Re-enable.** Only `driver/test/branch-reporter.test.ts:380`. |
| `suspicious/noPrototypeBuiltins` | 1 | 1 | **Re-enable + fix.** `driver/src/docker.ts:342` uses `Object.prototype.hasOwnProperty` off the target — use `Object.hasOwn`. |
| `complexity/useRegexLiterals` | 1 | 0 | **Re-enable**, test-only (`driver/test/executor-images.test.ts:52`). |
| `suspicious/useIterableCallbackReturn` | 2 | 0 | **Re-enable**, test-only. |
| `complexity/noAdjacentSpacesInRegex` | 3 | 0 | **Re-enable**, all 3 in `driver/test/executor-images.test.ts`. |
| `correctness/noUnsafeOptionalChaining` | 3 | 0 | **Re-enable**, all 3 in `driver/test/k8s.test.ts`. Real-bug class; keeping it off for 3 test sites is bad value. |
| `correctness/useJsxKeyInIterable` | 6 | 6 | **Re-enable + fix.** `web/src/panels/IdentityPanel.tsx` (3), `TaskOutcome.tsx` (3). React reconciliation bugs, not style. |
| `suspicious/noControlCharactersInRegex` | 7 | 7 | **Keep off.** All 7 are `driver/src/runner.ts:247` `stripAnsi` — exactly the documented carve-out. Better: narrow it to an `overrides` entry for that one file so the rest of the tree is covered. |
| `suspicious/noArrayIndexKey` | 7 | 7 | **Keep off** but narrow: all 7 are `web/src/charts/{BarChart,Axes,Scatter}.tsx` — the documented "index keys drive chart ticks" case. Scope the carve-out to `web/src/charts/**`. |
| `style/useImportType` | 10 | 8 | **Re-enable + autofix.** `biome check --write` fixes all of them; `verbatimModuleSyntax` makes this a correctness rule here, not taste. |
| `correctness/useExhaustiveDependencies` | 11 | 11 | **Worth a pass.** `web/src/api/useTasks.ts` (3, incl. two missing `stopChain` deps at :532/:545), `TaskDetailPage.tsx` (2). These are stale-closure bugs. Recommend enabling at `warn` and burning down. |
| `complexity/useLiteralKeys` | 13 | 11 | **Keep off**, narrow: 10 of 13 are `server/src/telemetry/otlp.ts` — the documented raw-JSON contract. Scope to that file. |
| `correctness/noUnusedFunctionParameters` | 17 | 3 | **Re-enable.** Only 3 non-test (`driver/src/{gates.ts:208,k8s-fence.ts:343,loop-run.ts:464}`); prefix with `_`. |
| `style/useTemplate` | 38 | — | Low value, pure style, autofixable. Optional. |
| `complexity/useOptionalChain` | 64 | — | Autofixable but churny. Defer. |
| `style/noNonNullAssertion` | **661** | — | **Keep off.** House style under `noUncheckedIndexedAccess`, as documented. |

---

## 2. New rules that catch real bugs (ranked)

### Tier A — real defects found, low noise

| Rule | Hits | Non-test | What it found |
| --- | ---: | ---: | --- |
| `correctness/useImportExtensions` **with `forceJsExtensions: true`** | **1** | 1 | Enforces the repo's single hardest-to-remember invariant ("relative imports carry a `.js` extension even in `.tsx`", AGENTS.md) across all four packages, at a cost of **one** suppression (`web/src/main.tsx:7`, `import './styles.css'`). Without the option it reports 1401 — the option is mandatory. **Top recommendation.** |
| `suspicious/noUnnecessaryConditions` | 37 | 16 | Finds genuinely dead defensive code. Best hit: `driver/src/docker.ts:306` `job.leaseToken !== undefined` and `:309` `job.leaseToken ?? ''` — `BoardJob.leaseToken` is `string` (`driver/src/board.ts:21`), so **both guards are dead** and `envFilePath` can never take its no-token branch. Also `server/src/db/migrate.ts:186` (unnecessary `?.`), `server/src/db/workflow-store.ts:92,101`. |
| `nursery/useExhaustiveSwitchCases` | **1** | 1 | `web/src/task-tree.ts:62` — `taskStatusLabel(): string` ends in a non-exhaustive `switch` with no trailing `return`, so an unhandled `TaskStatus` returns `undefined` into the nav label. One hit, one real bug. |
| `nursery/noFloatingPromises` | **2** | 2 | `web/src/api/useWorkflows.ts:71`, `web/src/pages/TaskDetailPage.tsx:164` — unhandled rejections in effects. Two hits. |
| `nursery/noLoopFunc` | **2** | 2 | `driver/src/index.ts:69`, `server/src/workspace/queue.ts:122` — closures over loop variables. Worth a read even if both turn out safe. |
| `nursery/noBaseToString` | 8 | 5 | `driver/src/k8s-gates.ts:111`, `driver/src/k8s-poll.ts:{193,219,289}`, `web/src/format.ts:126` — `[object Object]` leaking into log lines and k8s error text. Driver logs are what you read when a job fails; this is the rule that keeps them readable. |
| `suspicious/useArraySortCompare` | 20 | **3** | `server/src/backfill/transcripts.ts:70`, `web/src/components/repository-setup.ts:44`, `web/src/pages/SettingsRepositoriesPage.tsx:86`. Lexicographic sorts. Check each; if any sort numbers it is a live bug. |
| `nursery/noUselessTypeConversion` | 4 | 1 | `server/src/telemetry/otlp.ts:96` `Number()` on a number — harmless, but in the OTLP parser it signals a misread of the payload shape. |
| `correctness/useUniqueElementIds` | 17 | 17 | Duplicate DOM ids (`web/src/components/ExecutorDialog.tsx` ×4, `TaskInboxPage.tsx` ×3). Breaks `<label for>` and Playwright selectors — directly relevant to `npm run verify:ui`. |

### Tier B — convention/ratchet value, zero cost today

These all report **0 hits**. Enabling them costs nothing now and prevents the class forever:

`suspicious/noDoubleEquals`, `suspicious/noImportCycles`, `suspicious/noFocusedTests`, `suspicious/noSkippedTests`,
`suspicious/noExportsInTest`, `suspicious/noDuplicateTestHooks`, `suspicious/noTsIgnore`,
`suspicious/noConstantBinaryExpressions`, `suspicious/noUndeclaredEnvVars`, `suspicious/useErrorMessage`,
`correctness/noUnusedPrivateClassMembers`, `correctness/noPrivateImports`, `correctness/useParseIntRadix`,
`style/useExportType`, `style/useNodejsImportProtocol`, `style/noCommonJs`, `style/noEnum`, `style/noSubstr`,
`style/useReadonlyClassProperties`, `style/noYodaExpression`, `style/useThrowOnlyError`, `style/noInferrableTypes`,
`style/useShorthandFunctionType`, `style/noMultilineString`, `complexity/noUselessUndefined`, `complexity/useDateNow`,
`complexity/useIndexOf`, `complexity/noImplicitCoercions`, `complexity/noCommaOperator`, `complexity/useWhile`,
`complexity/noStaticOnlyClass`, `complexity/noUselessCatchBinding`, `complexity/noExcessiveNestedTestSuites`,
`nursery/noUnsafePlusOperands`, `nursery/noExtendNative`, `nursery/noIdenticalTestTitle`,
`nursery/noExcessiveNestedCallbacks`, `nursery/useConsistentTestIt`, `nursery/useTestHooksInOrder`,
`nursery/noTopLevelLiterals`, `nursery/useIncludes`, `nursery/useRegexpTest`, `nursery/useArraySome`,
`nursery/useImportsFirst`, `security/noGlobalEval`, `security/noDangerouslySetInnerHtml`,
`performance/noAccumulatingSpread`.

Note `noFocusedTests`/`noSkippedTests`/`noExportsInTest` are especially cheap insurance given
`docs/executor-testing.md` coverage gates — a stray `.only` silently shrinks the measured surface.

Near-zero, worth the one fix each: `style/useCollapsedIf` (1, `server/src/auth/plugin.ts:354`),
`complexity/noForEach` (1, test-only), `complexity/useArrayFind` (1, test-only),
`style/useConsistentObjectDefinitions` (1, test-only), `suspicious/noEvolvingTypes` (1, test-only),
`nursery/useStringStartsEndsWith` (3, `web/src/panels/env-raw.ts`),
`complexity/noUselessStringConcat` (3), `style/useNumberNamespace` (3),
`style/noParameterAssign` (3), `performance/noNamespaceImport` (3), `style/noDefaultExport` (5 — all
root config files; add an override and enable).

### Tier C — real signal, but a burn-down project

| Rule | Hits | Non-test | Note |
| --- | ---: | ---: | --- |
| `style/useErrorCause` | 15 | 15 | `driver/src/docker-runner-support.ts` ×5, `k8s-services.ts`, `server/src/config.ts`, `github/app-token.ts`. Rethrows that drop the original. Genuinely useful for driver debugging. Recommend **enabling at `warn`**. |
| `nursery/useNullishCoalescing` | 16 | 6 | `driver/src/gates.ts:{109,116,120}` `||` where `??` is meant — a gate that treats `0`/`''` as absent is a behavior bug. Worth reading those 3 even if the rule stays off. |
| `nursery/noUnmodifiedLoopCondition` | 6 | 4 | **Mostly false positives** — `core/src/telemetry.ts:131` mutates `cursor` via `setUTCDate`, which the rule cannot see. Skip. |
| `nursery/noMisusedPromises` | 19 | 18 | **Mostly false positives here.** `server/src/cache.ts:47` `if (pending)` and `job-store-org-resolvers.ts:59` `if (ready)` are legitimate nullable-promise guards (`ready?: Promise<unknown>`). Not worth it until the rule understands optional promises. |
| `suspicious/useAwait` | 340 | 42 | Signal exists (`driver/src/gates.ts:247`, `helpers.ts:422`, `k8s-gates.ts:261`, `app.ts:112`) but 42 non-test sites, many deliberately async for interface parity. Defer. |
| `suspicious/noShadow` | 150 | ~20 | Defer. |
| `style/noProcessEnv` | 112 | 9 ts | Attractive (config.ts is the documented single home) but 100+ hits are `driver/src/scripts/*.cjs`, which run **inside containers** and legitimately read env. Scope it: enable for `server/src/**` + `driver/src/**` excluding `config.ts`, `index.ts`, `main.ts` and `scripts/**` → ~9 sites. |
| `correctness/noUnresolvedImports` | 12 | 5 | Type-aware, but 5 of 12 are false positives (`node:sqlite` unknown to Biome; `react`'s `StrictMode`; type-only re-exports). Not yet. |

### Explicitly rejected (measured, too noisy for this tree)

`nursery/noUnsafeTypeAssertion` (1006), `nursery/useExplicitReturnType` (1170),
`nursery/useUnicodeRegex` (609), `nursery/useAwaitThenable` (499), `performance/useTopLevelRegex` (446),
`correctness/noNodejsModules` (199 — wrong rule for a repo with three node packages),
`correctness/noUndeclaredDependencies` (186 — hoisted workspace deps),
`style/useDestructuring` (175), `security/noSecrets` (129 — fixture tokens),
`suspicious/noEmptyBlockStatements` (127), `performance/noAwaitInLoops` (109 — sequential by design),
`suspicious/noConsole` (65 — CLIs print), `complexity/useSimplifiedLogicExpression` (65),
`complexity/noVoid` (78 — `void promise` is the codebase's deliberate fire-and-forget marker),
`style/useExplicitLengthCheck` (43), `correctness/useHookAtTopLevel` (39 — false positives on
`server/test-db` `use*` helpers that are not React hooks), `suspicious/noMisplacedAssertion` (34),
`style/noNestedTernary` (25), `style/useAtIndex` (24).

---

## 3. New GritQL plugins for repo invariants

`lint/no-shared-literals.grit` is the model. Three of the four documented-but-unenforced invariants
are expressible; one is not.

### 3.1 `lint/no-inline-container-scripts.grit` — **recommended, verified 0 hits**

AGENTS.md: *"Container scripts are files, never inline strings."* Today nothing enforces it; the
next `node -e` with a template literal lands silently.

A naive `'-e'` match produces false positives — `docker run -e KEY=VAL` uses the same flag
(`driver/src/docker-runner-support.ts:134`). Anchoring on the interpreter fixes it. Verified: this
plugin compiles under Biome 2.5.13 and reports **0** hits on `driver/src` today, so it is a pure
ratchet.

```grit
language js

// Container scripts are files, never inline strings (AGENTS.md). The argument after `node -e` or
// `sh -c` must be an identifier bound to a constant read from driver/src/scripts/ at load time —
// a string or template literal here is a script that only exists in argv, cannot be `sh -n`
// checked, and interpolates its parameters into code.
or {
    `['node', '-e', $body, $...]`,
    `[$..., 'node', '-e', $body, $...]`,
    `['sh', '-c', $body, $...]`,
    `[$..., 'sh', '-c', $body, $...]`
} where {
    $body <: or { JsStringLiteralExpression(), JsTemplateExpression() },
    register_diagnostic(
        span = $body,
        message = "Container script passed inline. Put it in driver/src/scripts/ and import the constant (AGENTS.md)."
    )
}
```

### 3.2 `lint/no-cross-package-imports.grit` — recommended, 0 hits

AGENTS.md: *"`driver` depends on nothing, `core` included"*, and server/web resolve core through
`@factory-ai/core`, never `core/src`. Both are 0 violations today (measured by grep) and both are
exactly the kind of thing a hurried change breaks.

```grit
language js

`import $_ from $source` where {
    or {
        and {
            $filename <: r".*/driver/(src|test)/.*",
            $source <: r"^['\"]@factory-ai/core.*['\"]$",
            register_diagnostic(span = $source, message = "driver depends on nothing, core included — copy the type (AGENTS.md).")
        },
        and {
            $filename <: r".*/(server|web)/src/.*",
            $source <: r"^['\"].*core/src/.*['\"]$",
            register_diagnostic(span = $source, message = "server and web resolve core through @factory-ai/core (core/dist), never core/src.")
        }
    }
}
```

### 3.3 `.js` extension on relative imports — **do not write a plugin**

Use `correctness/useImportExtensions` with `forceJsExtensions: true` (section 2). It is a built-in,
type-aware, autofixable, and measured at 1 hit. A Grit plugin would be strictly worse.

### 3.4 "A new file in `core/src` must be re-exported from `core/src/index.ts`" — **not expressible in Grit**

Grit patterns are per-file; this invariant is a set comparison between `core/src/*.ts` and the
re-exports in `index.ts`. `core/src` has 12 files against 17 export statements in `index.ts`, and
nothing checks the mapping. Enforce it with a vitest case next to the existing meta-tests
(`core/test/biome.test.ts`, `core/test/docs.terminology.test.ts`): `readdir('core/src')`, drop
`index.ts`, assert each remaining basename appears in an `export … from './<name>.js'` line.
Cheap, and it fails with a message that names the missing file instead of "module has no exported
member".

---

## 4. Concrete `biome.json` diffs

### Step 1 — free: delete stale carve-outs (0 violations each)

```diff
             "a11y": {
-                "noSvgWithoutTitle": "off"
+                "recommended": true
             },
             "complexity": {
@@
-                "noAdjacentSpacesInRegex": "off",
-                "noUselessFragments": "off",
-                "useLiteralKeys": "off",
                 "useOptionalChain": "off",
-                "useRegexLiterals": "off"
             },
             "correctness": {
-                "noUnusedFunctionParameters": "off",
                 "noUnusedImports": "error",
                 "noUnusedVariables": "error",
-                "noUnsafeOptionalChaining": "off",
                 "useExhaustiveDependencies": "off",
-                "useJsxKeyInIterable": "off"
             },
             "style": {
@@
                 "noNonNullAssertion": "off",
-                "useImportType": "off",
                 "useTemplate": "off"
             },
             "suspicious": {
-                "noArrayIndexKey": "off",
-                "noAssignInExpressions": "off",
-                "noControlCharactersInRegex": "off",
-                "noImplicitAnyLet": "off",
-                "noPrototypeBuiltins": "off",
-                "noRedeclare": "off",
-                "useIterableCallbackReturn": "off"
             }
```

Paired fixes required: `driver/src/k8s-gates.ts:213`, `driver/src/docker.ts:342`
(`Object.hasOwn`), `web/src/panels/IdentityPanel.tsx` + `TaskOutcome.tsx` (keys),
`driver/src/{gates.ts:208,k8s-fence.ts:343,loop-run.ts:464}` (`_`-prefix), plus
`npx biome check --write` for `useImportType`. The three narrowed carve-outs
(`noArrayIndexKey`, `noControlCharactersInRegex`, `useLiteralKeys`) move to `overrides`:

```diff
     "overrides": [
+        {
+            "includes": ["web/src/charts/**"],
+            "linter": { "rules": { "suspicious": { "noArrayIndexKey": "off" } } }
+        },
+        {
+            "includes": ["driver/src/runner.ts"],
+            "linter": { "rules": { "suspicious": { "noControlCharactersInRegex": "off" } } }
+        },
+        {
+            "includes": ["server/src/telemetry/otlp.ts"],
+            "linter": { "rules": { "complexity": { "useLiteralKeys": "off" } } }
+        },
         {
             "includes": ["core/test/**", ...
```

### Step 2 — the bug catchers

```diff
             "correctness": {
                 "noUnusedImports": "error",
                 "noUnusedVariables": "error",
                 "useExhaustiveDependencies": "warn",
+                "useImportExtensions": {
+                    "level": "error",
+                    "options": { "forceJsExtensions": true }
+                },
+                "useUniqueElementIds": "error"
             },
             "suspicious": {
+                "noUnnecessaryConditions": "error",
+                "useArraySortCompare": "error",
+                "noDoubleEquals": "error",
+                "noImportCycles": "error",
+                "noFocusedTests": "error",
+                "noSkippedTests": "error",
+                "noExportsInTest": "error",
+                "noDuplicateTestHooks": "error",
+                "noTsIgnore": "error",
+                "noConstantBinaryExpressions": "error",
+                "noUndeclaredEnvVars": "error",
+                "useErrorMessage": "error"
             },
+            "nursery": {
+                "noFloatingPromises": "error",
+                "noLoopFunc": "error",
+                "noBaseToString": "error",
+                "noUselessTypeConversion": "error",
+                "useExhaustiveSwitchCases": "error",
+                "noUnsafePlusOperands": "error",
+                "noExtendNative": "error",
+                "noIdenticalTestTitle": "error",
+                "useConsistentTestIt": "error",
+                "useTestHooksInOrder": "error",
+                "useImportsFirst": "error",
+                "useIncludes": "error",
+                "useRegexpTest": "error",
+                "useArraySome": "error"
+            },
+            "security": {
+                "noGlobalEval": "error",
+                "noDangerouslySetInnerHtml": "error"
+            },
+            "performance": {
+                "noAccumulatingSpread": "error",
+                "noNamespaceImport": "error"
+            },
             "style": {
                 "noExcessiveLinesPerFile": { ... },
                 "noMagicNumbers": "error",
                 "noNonNullAssertion": "off",
                 "useTemplate": "off",
+                "useErrorCause": "warn",
+                "useExportType": "error",
+                "useNodejsImportProtocol": "error",
+                "noCommonJs": "error",
+                "noEnum": "error",
+                "noSubstr": "error",
+                "useReadonlyClassProperties": "error",
+                "noYodaExpression": "error",
+                "useThrowOnlyError": "error",
+                "noInferrableTypes": "error",
+                "useShorthandFunctionType": "error",
+                "noMultilineString": "error",
+                "useCollapsedIf": "error",
+                "noParameterAssign": "error",
+                "useNumberNamespace": "error",
+                "noDefaultExport": "error"
+            },
+            "complexity": {
+                "noUselessUndefined": "error",
+                "useDateNow": "error",
+                "useIndexOf": "error",
+                "noImplicitCoercions": "error",
+                "noCommaOperator": "error",
+                "useWhile": "error",
+                "noStaticOnlyClass": "error",
+                "noUselessCatchBinding": "error",
+                "noExcessiveNestedTestSuites": "error",
+                "noForEach": "error",
+                "useArrayFind": "error"
             },
```

Two overrides go with Step 2:

```diff
+        {
+            "includes": ["web/src/main.tsx"],
+            "comment": "the one bare CSS side-effect import; useImportExtensions has no CSS mode",
+            "linter": { "rules": { "correctness": { "useImportExtensions": "off" } } }
+        },
+        {
+            "includes": ["*.config.ts", "playwright.config.ts"],
+            "linter": { "rules": { "style": { "noDefaultExport": "off" } } }
+        },
+        {
+            "includes": ["driver/src/scripts/**"],
+            "comment": "these run inside containers and read env directly",
+            "linter": { "rules": { "correctness": { "noUndeclaredVariables": "off" } } }
+        },
```

### Step 3 — plugins

```diff
-    "plugins": ["./lint/no-shared-literals.grit"],
+    "plugins": [
+        "./lint/no-shared-literals.grit",
+        "./lint/no-inline-container-scripts.grit",
+        "./lint/no-cross-package-imports.grit"
+    ],
```

Both new plugins are 0-hit ratchets. `core/test/biome.test.ts` already pins the enforced style —
extend it to assert the plugin list, the way it pins the formatter options.

### Sequencing

Step 1 and Step 3 can land together (Step 1's paired fixes are ~10 lines; Step 3 is free).
Step 2's Tier-B block is free; the Tier-A block (`noUnnecessaryConditions` 16 non-test,
`useUniqueElementIds` 17, `useArraySortCompare` 3) wants its own PR with the fixes, starting with
the dead `leaseToken` guard in `driver/src/docker.ts:306`.
