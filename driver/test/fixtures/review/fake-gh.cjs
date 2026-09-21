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

const argv = process.argv.slice(2);
const env = process.env;

if (env.GH_ARGV_LOG) fs.appendFileSync(env.GH_ARGV_LOG, `${JSON.stringify(argv)}\n`);

if (!(env.GH_TOKEN || env.GITHUB_TOKEN)) {
    process.stderr.write('gh: no credential env\n');
    process.exit(3);
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
const emit = (key) => {
    process.stdout.write(JSON.stringify(fixtures[key]));
    process.exit(0);
};

if (joined.includes('graphql')) {
    const query = argv.find((a) => a.startsWith('query=')) ?? '';
    if (query.includes('resolveReviewThread')) emit('resolve');
    emit('threads');
}
if (joined.includes('requested_reviewers')) emit('requested');
if (/issues\/\d+\/comments/.test(joined)) emit('general');
if (/\/reviews(\s|$)/.test(joined)) emit('reviews');
if (/comments\/\d+\/replies/.test(joined)) emit('reply');
if (/pulls\/\d+\/comments(\s|$)/.test(joined)) emit('inline');
process.stderr.write(`gh: no fixture for ${joined}\n`);
process.exit(127);
