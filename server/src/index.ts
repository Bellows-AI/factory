import { start } from './main.js';

// The deployment entry. The environment is the only configuration, and it can only ever produce
// the GitHub App — see loadGitHub, which refuses to boot without the id and the private key.
await start();
