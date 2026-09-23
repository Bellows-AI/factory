/**
 * Regenerates telemetry-sessions.json:
 *
 *     node core/test/fixtures/generate-telemetry.mjs
 *
 * Committed so the fixture is reproducible and reviewable as intent rather than as 600 lines
 * of JSON. This is SYNTHETIC — hence the loud badge the UI shows when it is the active source.
 *
 * The degradation cases are the point of this file. Each session is labelled with the case it
 * exercises; deleting one silently removes a test.
 */
import { writeFileSync } from 'node:fs';

const REPO = 'Bellows-AI/bellows.ai';
const sessions = [];

// Who queued the board task the session belongs to, resolved server-side by joining
// session_branch to job on session id. Sessions with no matching job row (local dev runs,
// backfilled transcripts) carry null — the fixture exercises both.
const ALICE = { id: 'u-alice', login: 'alice', name: 'Alice Doe', avatarUrl: 'https://example.com/alice.png' };
const BOB = { id: 'u-bob', login: 'bob', name: null, avatarUrl: null };

function session(id, opts) {
    const {
        repo = REPO,
        from,
        to,
        tokens,
        linesAdded,
        linesRemoved,
        editsAccepted,
        editsRejected,
        activeSeconds,
        commits = 0,
        user = null,
        taskKey = null,
    } = opts;

    sessions.push({
        sessionId: id,
        agent: 'claude-code',
        repo,
        firstSeen: from,
        lastSeen: to,
        tokens,
        linesAdded,
        linesRemoved,
        editsAccepted,
        editsRejected,
        activeSeconds,
        commits,
        user,
        taskKey,
    });
}

// Named fields rather than positional args: each token count is then an object property value,
// which is its own name — the point of this file is the numbers being reviewable as intent.
const T = ({ input, output, cacheRead, cacheCreation }) => ({ input, output, cacheRead, cacheCreation });

session('s01-token-heavy', {
    from: '2026-08-21T06:20:00Z',
    to: '2026-08-21T06:45:00Z',
    tokens: T({ input: 74000, output: 12000, cacheRead: 410000, cacheCreation: 31000 }),
    linesAdded: 380,
    linesRemoved: 116,
    editsAccepted: 18,
    editsRejected: 2,
    activeSeconds: 1320,
    commits: 3,
    user: ALICE,
    taskKey: 't-s01',
});

session('s02-mid-a', {
    from: '2026-08-17T08:20:00Z',
    to: '2026-08-17T08:45:00Z',
    tokens: T({ input: 51000, output: 9000, cacheRead: 288000, cacheCreation: 17000 }),
    linesAdded: 240,
    linesRemoved: 90,
    editsAccepted: 11,
    editsRejected: 1,
    activeSeconds: 1080,
    commits: 2,
    user: ALICE,
    taskKey: 't-s02',
});

session('s03-mid-b', {
    from: '2026-08-17T08:46:00Z',
    to: '2026-08-17T09:02:00Z',
    tokens: T({ input: 33000, output: 6000, cacheRead: 190000, cacheCreation: 8000 }),
    linesAdded: 300,
    linesRemoved: 44,
    editsAccepted: 7,
    editsRejected: 3,
    activeSeconds: 720,
    commits: 1,
    user: ALICE,
    taskKey: 't-s03',
});

session('s04-april', {
    from: '2026-04-20T14:30:00Z',
    to: '2026-04-20T16:00:00Z',
    tokens: T({ input: 60000, output: 10000, cacheRead: 300000, cacheCreation: 20000 }),
    linesAdded: 200,
    linesRemoved: 50,
    editsAccepted: 10,
    editsRejected: 5,
    activeSeconds: 3000,
    commits: 4,
    user: BOB,
    taskKey: 't-s04',
});

// Stretches the weekly window so the seeded-series assertion has interior gaps to catch.
session('s05-april-earliest', {
    from: '2026-04-15T12:00:00Z',
    to: '2026-04-15T14:00:00Z',
    tokens: T({ input: 48000, output: 8000, cacheRead: 260000, cacheCreation: 14000 }),
    linesAdded: 150,
    linesRemoved: 30,
    editsAccepted: 9,
    editsRejected: 2,
    activeSeconds: 2400,
    commits: 2,
    user: BOB,
    taskKey: 't-s05',
});

session('s06-may', {
    from: '2026-05-12T09:50:00Z',
    to: '2026-05-12T11:00:00Z',
    tokens: T({ input: 29000, output: 5000, cacheRead: 150000, cacheCreation: 9000 }),
    linesAdded: 120,
    linesRemoved: 60,
    editsAccepted: 6,
    editsRejected: 1,
    activeSeconds: 3600,
    commits: 2,
    user: BOB,
    taskKey: 't-s06',
});

session('s07-july-a', {
    from: '2026-07-10T09:00:00Z',
    to: '2026-07-10T09:30:00Z',
    tokens: T({ input: 12000, output: 2000, cacheRead: 60000, cacheCreation: 3000 }),
    linesAdded: 40,
    linesRemoved: 10,
    editsAccepted: 3,
    editsRejected: 4,
    activeSeconds: 900,
});

session('s08-july-b', {
    from: '2026-07-11T09:00:00Z',
    to: '2026-07-11T09:20:00Z',
    tokens: T({ input: 7000, output: 1200, cacheRead: 30000, cacheCreation: 1500 }),
    linesAdded: 12,
    linesRemoved: 4,
    editsAccepted: 1,
    editsRejected: 0,
    activeSeconds: 600,
});

// Case: another repo -> excluded from totals, counted in otherRepoSessions. Deliberately the
// largest session in the file, so a broken filter shows up as an obviously inflated total.
// Carries a user: out-of-repo-scope sessions must stay out of byUser even when attributed.
session('s09-other-repo', {
    repo: 'Bellows-AI/other-service',
    from: '2026-07-12T09:00:00Z',
    to: '2026-07-12T10:00:00Z',
    tokens: T({ input: 90000, output: 15000, cacheRead: 500000, cacheCreation: 40000 }),
    linesAdded: 900,
    linesRemoved: 300,
    editsAccepted: 40,
    editsRejected: 5,
    activeSeconds: 3600,
    commits: 6,
    user: BOB,
    taskKey: 't-s09',
});

// Case: telemetry arrived but the hook never reported -> sessionsWithoutHook.
session('s10-no-hook', {
    repo: null,
    from: '2026-07-13T09:00:00Z',
    to: '2026-07-13T09:40:00Z',
    tokens: T({ input: 20000, output: 4000, cacheRead: 100000, cacheCreation: 6000 }),
    linesAdded: 70,
    linesRemoved: 20,
    editsAccepted: 5,
    editsRejected: 1,
    activeSeconds: 1500,
    commits: 1,
});

session('s11-july-c', {
    from: '2026-07-21T06:00:00Z',
    to: '2026-07-21T06:30:00Z',
    tokens: T({ input: 18000, output: 3000, cacheRead: 95000, cacheCreation: 5000 }),
    linesAdded: 100,
    linesRemoved: 25,
    editsAccepted: 4,
    editsRejected: 0,
    activeSeconds: 1500,
    commits: 1,
});

session('s12-june', {
    from: '2026-06-01T09:00:00Z',
    to: '2026-06-01T09:25:00Z',
    tokens: T({ input: 9000, output: 1500, cacheRead: 40000, cacheCreation: 2000 }),
    linesAdded: 25,
    linesRemoved: 8,
    editsAccepted: 2,
    editsRejected: 1,
    activeSeconds: 780,
    user: ALICE,
    taskKey: 't-s12',
});

session('s13-august', {
    from: '2026-08-20T10:00:00Z',
    to: '2026-08-20T10:50:00Z',
    tokens: T({ input: 41000, output: 7000, cacheRead: 220000, cacheCreation: 12000 }),
    linesAdded: 160,
    linesRemoved: 55,
    editsAccepted: 8,
    editsRejected: 2,
    activeSeconds: 2700,
    commits: 2,
    user: BOB,
    taskKey: 't-s13',
});

session('s14-july-d', {
    from: '2026-07-02T21:05:00Z',
    to: '2026-07-02T21:20:00Z',
    tokens: T({ input: 37000, output: 6500, cacheRead: 180000, cacheCreation: 11000 }),
    linesAdded: 140,
    linesRemoved: 35,
    editsAccepted: 9,
    editsRejected: 1,
    activeSeconds: 900,
    commits: 2,
});

session('s15-june-b', {
    from: '2026-06-29T20:58:00Z',
    to: '2026-06-29T21:06:00Z',
    tokens: T({ input: 22000, output: 4000, cacheRead: 110000, cacheCreation: 7000 }),
    linesAdded: 80,
    linesRemoved: 20,
    editsAccepted: 5,
    editsRejected: 2,
    activeSeconds: 480,
    commits: 2,
    user: ALICE,
    taskKey: 't-s15',
});

const ordered = [...sessions].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
const payload = {
    sessions,
    coverage: {
        from: ordered[0].firstSeen,
        to: ordered[ordered.length - 1].lastSeen,
    },
};

const target = new URL('./telemetry-sessions.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(payload, null, 4)}\n`);
console.log(`wrote ${sessions.length} sessions`);
