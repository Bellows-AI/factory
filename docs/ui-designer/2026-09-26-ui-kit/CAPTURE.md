# Capture notes

Captured 26 September 2026 from working-tree revision `c503351`. Product UI brand: Bellows. Repository: factory-ai.

## What is included

38 freshly generated PNG screenshots, copied without image manipulation from `artifacts/ui/`. The [manifest](capture-manifest.json) records source filenames, capture timestamps, image dimensions, route, and caption for each image. Image height may exceed viewport height because most captures show the full page.

Coverage: all main shell routes, completed task detail and follow-up thread, dark/light comparisons, desktop/tablet/phone widths, mobile navigation, menus, date-range dialog, destructive confirmation and refusal, stale board data, authenticated repository/environment/executor configuration, sign-in and onboarding.

Read the gallery captions before interpreting a screen. Open-mode fixtures deliberately have no configured checkout workspace/personal executor. Authenticated fixtures use a stub GitHub identity. Usage and task history are synthetic. The screenshots do not depict production usage or actual agent work performed for this handoff.

## Reproduction

From the repository root, with Timescale running and disposable `factory_e2e` and `factory_auth_e2e` databases available:

```sh
npx playwright test e2e/navigation.spec.ts e2e/dashboard.spec.ts e2e/task-detail.spec.ts e2e/composer.spec.ts e2e/auth.spec.ts e2e/workspace.spec.ts > /tmp/factory-designer-capture.log 2>&1
node docs/ui-designer/2026-09-26-ui-kit/package.mjs
```

The Playwright configuration builds the app, resets/seeds only its disposable databases, starts the offline app and stub identity provider, and stops those servers when finished. No real agent executor is launched. `package.mjs` curates the captures and generates the HTML gallery and manifest; it refuses images older than the capture log's creation time. The temporary log must exist to rebuild the package. The supplied HTML and images require no server, installation, or internet connection.

## Verification outcome

The selected browser suite finished with **78 passed and 13 failed**. This is not a green regression run. The passing capture matrix produced the route/theme/width references included here.

Failure groups observed in the run:

- Three composer checks: expected blocker text was absent, or the keyboard-launch URL expectation timed out with missing executor setup.
- One custom-range interaction: timed out looking for the Custom option.
- Five appearance checks: old native-select/option assumptions or the old `.theme-select` selector conflict with the current custom selector.
- One task-action scenario: Start task remained disabled, so the queued/running/stopping capture sequence could not proceed.
- Three authentication checks: two use old native appearance-selector assumptions; one times out attempting to click disabled Continue with no organization selected.

These are observed assertions and timeouts, not a complete diagnosis of every failure. Application code and tests were not changed in this design-documentation task. The attempted supplementary capture script started after the suite had stopped its servers and produced no images; none of its output is included.

## Visual review and gaps

Representative images were visually inspected: dark desktop composer, light dashboard, rich task detail, authenticated repository editor, and dark phone inbox. This checks that the references show rendered content and meaningful layouts; it is not an accessibility certification or exhaustive visual audit.

No dedicated screenshot is supplied for an active running task, an intentional PR-review wait, a failed verification gate, or every environment save/error/reveal state. These remain explicitly required design states in `COMPONENTS.md`. The completed detail image demonstrates verification structure, not failed-gate behavior. Some captures intentionally retain keyboard focus rings.

Existing layout roughness is preserved as design evidence. In particular, the repository action wraps awkwardly, the task result can show red “exit 0” / “0 failed,” and the inbox's full-page phone image is very tall. Gallery previews crop to the top for readability; opening the image shows all original pixels.

## Share

Send `bellows-designer-handoff-2026-09-26.zip`. Extract it and open `index.html`. Narrative and inventory are embedded in that HTML; Markdown originals and capture notes are included for editing. Keep the `screenshots` folder beside the HTML. Repository source paths in the brief are references for engineering and are not needed to read the handoff.
