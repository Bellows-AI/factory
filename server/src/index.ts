import { start } from './main.js';

/*
 * The env entry: the App is the only configuration the environment can produce, so reading
 * `process.env` and passing no override can only ever yield `github.mode === 'app'` — see
 * start()'s doc comment in main.ts for the shape of the pair with offline.ts.
 */
await start();
