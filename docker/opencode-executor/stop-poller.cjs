#!/usr/bin/env node
'use strict';
// The runner's end of a cooperative Stop (issue #442). The driver opens a per-attempt control
// endpoint (BELLOWS_CONTROL_URL, scoped by BELLOWS_CONTROL_TOKEN) for every launched attempt;
// this reads it every BELLOWS_CONTROL_POLL_MS and, once a Stop is raised, writes the local stop
// marker at FACTORY_STOP_MARKER and exits. The agent-side mechanism (a Claude Code hook, an
// OpenCode plugin) reads ONLY that marker, so the agent never holds the control credential's
// reach beyond a file. A sibling of the CLI, never its parent: it kills nothing — the hard kill
// is the driver's, after its grace.
//
// Deliberate copy: docker/claude-executor/ and docker/opencode-executor/ each hold this file, byte
// for byte (driver/test/executor-images.test.ts), because each image's build context is its own
// directory.
const fs = require('node:fs');

const DEFAULT_POLL_MS = 5000;
const HTTP_UNAUTHORIZED = 401;

const url = process.env.BELLOWS_CONTROL_URL;
const token = process.env.BELLOWS_CONTROL_TOKEN;
const marker = process.env.FACTORY_STOP_MARKER;
const configuredPoll = Number(process.env.BELLOWS_CONTROL_POLL_MS);
const pollMs = Number.isFinite(configuredPoll) && configuredPoll > 0 ? configuredPoll : DEFAULT_POLL_MS;

/** 'stop' when a Stop is raised, 'closed' when the endpoint no longer knows the token, else 'run'. */
async function read() {
    try {
        const response = await fetch(`${url}/control`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(pollMs),
        });
        if (response.status === HTTP_UNAUTHORIZED) return 'closed';
        if (!response.ok) return 'run';
        const body = await response.json();
        return body && body.stop === true ? 'stop' : 'run';
    } catch {
        // An unreachable driver is not a Stop: the lease and the driver's own kill govern that.
        return 'run';
    }
}

async function main() {
    // No control channel (a driver without one, or an image run by hand): nothing to poll.
    if (!url || !token || !marker) return;
    for (;;) {
        const answer = await read();
        if (answer === 'stop') {
            fs.writeFileSync(marker, 'stop\n');
            return;
        }
        if (answer === 'closed') return;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

main();
