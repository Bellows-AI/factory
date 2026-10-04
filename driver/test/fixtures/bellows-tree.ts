import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathOf } from './scripts-support.js';

/** A `.bellows.yaml` declaring one service; `extra` is appended as further keys of that item. */
export const bellowsService = (name: string, extra = ''): string =>
    `services:\n  - name: ${name}\n    image: ${name}:1${extra}\n`;

/**
 * A real workspace mount on disk for the `.bellows.yaml` readout (issue #444): `write` lays a
 * file under the member tree `<mount>/<workspacePath>`, and `read` runs the shipped
 * `bellows-read.sh` with the env the driver built — so a test exercises the script and its env
 * contract together, on either executor.
 */
export function bellowsTree(workspacePath: string): {
    mount: string;
    write: (rel: string, text: string) => void;
    read: (env: Record<string, string>) => string;
} {
    const mount = realpathSync(mkdtempSync(join(tmpdir(), 'factory-bellows-')));
    return {
        mount,
        write: (rel, text) => {
            const file = join(mount, workspacePath, rel);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, text);
        },
        read: (env) =>
            execFileSync('sh', [pathOf('bellows-read.sh')], {
                env: { PATH: process.env.PATH, ...env },
                encoding: 'utf8',
            }),
    };
}

/** The env a `docker run` argv carries as `-e NAME=value` pairs. */
export function argvEnv(args: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    args.forEach((arg, i) => {
        if (args[i - 1] !== '-e') return;
        const at = arg.indexOf('=');
        env[arg.slice(0, at)] = arg.slice(at + 1);
    });
    return env;
}
