#!/usr/bin/env node
'use strict';

/*
 * A stub `gh` for the review helper suites: records every argv line (the spawn-shape pins), runs
 * only with a credential env present (the same net the scripts cast), answers bounded canned
 * payloads from $GH_FIXTURES, and — when $GH_HTTP_STATUS is set — fails the way `gh` fails a
 * non-2xx call: `gh: HTTP <code>: …` on stderr, exit 1, which is exactly the text the scripts'
 * status classification parses. A request that matches no fixture exits 127 like a real unknown
 * path. The token is never echoed or written; the tests assert that.
 */

const fs = require('node:fs');

const NO_CREDENTIAL_EXIT_CODE = 3;
const UNKNOWN_PATH_EXIT_CODE = 127;

const argv = process.argv.slice(2);
const env = process.env;

if (env.GH_ARGV_LOG) fs.appendFileSync(env.GH_ARGV_LOG, `${JSON.stringify(argv)}\n`);

if (!(env.GH_TOKEN || env.GITHUB_TOKEN)) {
    process.stderr.write('gh: no credential env\n');
    process.exit(NO_CREDENTIAL_EXIT_CODE);
}

if (env.GH_HTTP_STATUS) {
    const code = env.GH_HTTP_STATUS;
    const reason =
        code === '404'
            ? 'Not Found'
            : code === '401'
              ? 'Bad credentials'
              : code === '403'
                ? 'Forbidden'
                : code === '429'
                  ? 'rate limit exceeded'
                  : 'error';
    process.stderr.write(`gh: HTTP ${code}: ${reason} (stub)\n`);
    process.exit(1);
}

const fixtures = JSON.parse(fs.readFileSync(env.GH_FIXTURES, 'utf8'));
const joined = argv.join(' ');

let key = null;
const query = argv.find((a) => a.startsWith('query=')) ?? '';
if (joined.includes('graphql')) key = query.includes('resolveReviewThread') ? 'resolve' : 'threads';
if (joined.includes('requested_reviewers')) key = 'requested';
if (/issues\/\d+\/comments/.test(joined)) key = 'general';
if (/\/reviews(\s|$)/.test(joined)) key = 'reviews';
if (/comments\/\d+\/replies/.test(joined)) key = 'reply';
if (/pulls\/\d+\/comments(\s|$)/.test(joined)) key = 'inline';

if (key === null) {
    process.stderr.write(`gh: no fixture for ${joined}\n`);
    process.exit(UNKNOWN_PATH_EXIT_CODE);
}

const data = JSON.stringify(fixtures[key]);
const done = () => process.exit(0);
// A large payload (~300 KiB in the boundedness runs) outgrows the 64 KiB pipe buffer, so an
// eager exit truncates it — wait for the drain instead.
if (process.stdout.write(data)) done();
else process.stdout.once('drain', done);
