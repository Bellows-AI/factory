import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(root, 'scripts/release.sh');
const SKIP_CI = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i;

interface Fixture {
    env: NodeJS.ProcessEnv;
    remote: string;
    seed: string;
    work: string;
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(cwd: string, env: NodeJS.ProcessEnv, command: string, args: string[]) {
    return spawnSync(command, args, { cwd, env, encoding: 'utf8' });
}

function git(fixture: Fixture, cwd: string, ...args: string[]): string {
    const result = run(cwd, fixture.env, 'git', args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
}

/** The seed clone commits and pushes; the work clone then pulls, so it starts level with origin. */
function publish(fixture: Fixture, files: Record<string, string | null>, message = 'change'): void {
    for (const [name, contents] of Object.entries(files)) {
        if (contents === null) rmSync(join(fixture.seed, name));
        else writeFileSync(join(fixture.seed, name), contents);
    }
    git(fixture, fixture.seed, 'add', '-A');
    git(fixture, fixture.seed, 'commit', '-q', '-m', message);
    git(fixture, fixture.seed, 'push', '-q', 'origin', 'HEAD:main');
}

function setup(version: string | null = '0.0.2\n'): Fixture {
    const dir = mkdtempSync(join(tmpdir(), 'release-'));
    dirs.push(dir);
    const gitconfig = join(dir, 'gitconfig');
    writeFileSync(
        gitconfig,
        [
            '[user]',
            '\tname = Release Test',
            '\temail = release@example.invalid',
            '[init]',
            '\tdefaultBranch = main',
            '[commit]',
            '\tgpgsign = false',
            '[tag]',
            '\tgpgsign = false',
            '',
        ].join('\n')
    );
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_NOSYSTEM: '1',
    };
    const fixture: Fixture = { env, remote: join(dir, 'remote.git'), seed: join(dir, 'seed'), work: join(dir, 'work') };
    git(fixture, dir, 'init', '-q', '--bare', '-b', 'main', fixture.remote);
    git(fixture, dir, 'clone', '-q', fixture.remote, fixture.seed);
    publish(fixture, { 'README.md': 'release fixture\n', ...(version === null ? {} : { VERSION: version }) }, 'seed');
    git(fixture, dir, 'clone', '-q', fixture.remote, fixture.work);
    return fixture;
}

const release = (fixture: Fixture) => run(fixture.work, fixture.env, 'sh', [SCRIPT]);

function snapshot(fixture: Fixture) {
    const read = (cwd: string, ...args: string[]) => git(fixture, cwd, ...args);
    let version: string | null = null;
    try {
        version = readFileSync(join(fixture.work, 'VERSION'), 'utf8');
    } catch {
        // A fixture with no VERSION at all.
    }
    return {
        head: read(fixture.work, 'rev-parse', 'HEAD'),
        localTags: read(fixture.work, 'tag', '--list'),
        remoteMain: read(fixture.remote, 'rev-parse', 'main'),
        remoteTags: read(fixture.remote, 'tag', '--list'),
        status: read(fixture.work, 'status', '--porcelain'),
        version,
    };
}

function expectRefusal(fixture: Fixture, reason: RegExp): void {
    const before = snapshot(fixture);
    const result = release(fixture);
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toMatch(reason);
    expect(snapshot(fixture)).toEqual(before);
}

describe('npm run release', () => {
    it('is wired to scripts/release.sh', () => {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
        expect(pkg.scripts.release).toBe('sh scripts/release.sh');
    });

    it('cuts X.Y.(Z+1) as one version-only commit, tagged and pushed together', () => {
        const fixture = setup();
        const orig = git(fixture, fixture.work, 'rev-parse', 'HEAD');
        const result = release(fixture);
        expect(result.status, result.stderr).toBe(0);

        const head = git(fixture, fixture.work, 'rev-parse', 'HEAD');
        expect(readFileSync(join(fixture.work, 'VERSION'), 'utf8')).toBe('0.0.3\n');
        expect(git(fixture, fixture.work, 'rev-list', '--count', `${orig}..HEAD`)).toBe('1');
        expect(git(fixture, fixture.work, 'show', '--name-only', '--format=', 'HEAD')).toBe('VERSION');
        expect(git(fixture, fixture.work, 'rev-parse', 'v0.0.3^{commit}')).toBe(head);
        expect(git(fixture, fixture.remote, 'rev-parse', 'main')).toBe(head);
        expect(git(fixture, fixture.remote, 'rev-parse', 'v0.0.3^{commit}')).toBe(head);
        // GitHub skips every push workflow for a commit carrying one, the tag's release included.
        expect(git(fixture, fixture.work, 'log', '-1', '--format=%B')).not.toMatch(SKIP_CI);
        expect(git(fixture, fixture.work, 'status', '--porcelain')).toBe('');
    });

    it('increments only the patch component', () => {
        const fixture = setup('1.9.9\n');
        expect(release(fixture).status).toBe(0);
        expect(readFileSync(join(fixture.work, 'VERSION'), 'utf8')).toBe('1.9.10\n');
        expect(git(fixture, fixture.remote, 'tag', '--list')).toBe('v1.9.10');
    });

    it('refuses a re-run on an already-released HEAD', () => {
        const fixture = setup();
        expect(release(fixture).status).toBe(0);
        expectRefusal(fixture, /already released/);
        expect(git(fixture, fixture.remote, 'tag', '--list')).toBe('v0.0.3');
    });

    it('refuses a modified tracked file', () => {
        const fixture = setup();
        writeFileSync(join(fixture.work, 'README.md'), 'edited\n');
        expectRefusal(fixture, /not clean/);
    });

    it('refuses an untracked file', () => {
        const fixture = setup();
        writeFileSync(join(fixture.work, 'stray.txt'), 'stray\n');
        expectRefusal(fixture, /not clean/);
    });

    it('refuses a checkout behind origin', () => {
        const fixture = setup();
        publish(fixture, { 'README.md': 'moved on\n' });
        expectRefusal(fixture, /origin\/main/);
    });

    it('refuses a checkout ahead of origin', () => {
        const fixture = setup();
        writeFileSync(join(fixture.work, 'README.md'), 'unpushed\n');
        git(fixture, fixture.work, 'commit', '-q', '-am', 'unpushed');
        expectRefusal(fixture, /origin\/main/);
    });

    it('refuses a branch other than main', () => {
        const fixture = setup();
        git(fixture, fixture.work, 'switch', '-q', '-c', 'feature');
        expectRefusal(fixture, /not on main/);
    });

    it('refuses when the next tag already exists locally', () => {
        const fixture = setup();
        // A tag on HEAD would trip the already-released guard first; put it on another commit.
        git(fixture, fixture.work, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
        git(fixture, fixture.work, 'tag', 'v0.0.3');
        git(fixture, fixture.work, 'reset', '-q', '--hard', 'origin/main');
        expectRefusal(fixture, /v0\.0\.3 already exists/);
    });

    it('refuses when the next tag exists only on the remote', () => {
        const fixture = setup();
        git(fixture, fixture.seed, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
        git(fixture, fixture.seed, 'tag', 'v0.0.3');
        git(fixture, fixture.seed, 'push', '-q', 'origin', 'v0.0.3');
        expectRefusal(fixture, /v0\.0\.3 already exists/);
    });

    it.each([
        ['a leading v', 'v0.0.2\n'],
        ['two components', '0.0\n'],
        ['a prerelease', '0.0.2-rc.1\n'],
        ['a leading zero', '0.01.2\n'],
        ['two lines', '0.0.2\n0.0.3\n'],
        ['an empty file', ''],
    ])('refuses a VERSION with %s', (_label, contents) => {
        expectRefusal(setup(contents), /VERSION/);
    });

    it('refuses a missing VERSION', () => {
        expectRefusal(setup(null), /VERSION/);
    });

    it('lands nothing when the remote rejects either ref, and undoes its own commit and tag', () => {
        const fixture = setup();
        const hook = join(fixture.remote, 'hooks/update');
        writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\nexit 0\n');
        chmodSync(hook, 0o755);
        expectRefusal(fixture, /push/);
    });
});
