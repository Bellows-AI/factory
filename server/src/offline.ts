import { start } from './main.js';

/*
 * The offline entry: the same server, built with the code-only `none` arm of GitHubConfig — no
 * token provider, no App client, nothing fetched or cloned, the repo list falling back to the
 * rows the database already holds.
 *
 * This is how the env-booted harnesses — `npm run verify:ui` and `npm run test:jobs` — run a real
 * compiled server with no credential and no network. The no-fetch state is deliberately NOT
 * reachable from the environment: the only configuration there is the App, and an operator who
 * wants a deployment that fetches nothing is out of luck on purpose.
 */
await start({ github: { mode: 'none' } });
