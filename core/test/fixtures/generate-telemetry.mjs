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

const T = (input, output, cacheRead, cacheCreation) => ({ input, output, cacheRead, cacheCreation });

session('s01-token-heavy', {
    from: '2026-08-21T06:20:00Z',
    to: '2026-08-21T06:45:00Z',
    tokens: T(74000, 12000, 410000, 31000),
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
    tokens: T(51000, 9000, 288000, 17000),
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
    tokens: T(33000, 6000, 190000, 8000),
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
    tokens: T(60000, 10000, 300000, 20000),
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
    tokens: T(48000, 8000, 260000, 14000),
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
    tokens: T(29000, 5000, 150000, 9000),
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
    tokens: T(12000, 2000, 60000, 3000),
    linesAdded: 40,
    linesRemoved: 10,
    editsAccepted: 3,
    editsRejected: 4,
    activeSeconds: 900,
});

session('s08-july-b', {
    from: '2026-07-11T09:00:00Z',
    to: '2026-07-11T09:20:00Z',
    tokens: T(7000, 1200, 30000, 1500),
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
    tokens: T(90000, 15000, 500000, 40000),
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
    tokens: T(20000, 4000, 100000, 6000),
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
    tokens: T(18000, 3000, 95000, 5000),
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
    tokens: T(9000, 1500, 40000, 2000),
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
    tokens: T(41000, 7000, 220000, 12000),
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
    tokens: T(37000, 6500, 180000, 11000),
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
    tokens: T(22000, 4000, 110000, 7000),
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
