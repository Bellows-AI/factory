/**
 * The primitives every block of the `.bellows.yaml` grammar shares (`bellows.ts`, and the reviewer
 * profiles' `bellows-reviewers.ts`): the named error with its line number, the scalar reader and the
 * `key: value` line shape. Split out so a block can live in its own file without importing the
 * parser that dispatches to it.
 */

/** The longest command, setup or instruction text one line may carry. */
export const MAX_COMMAND_LENGTH = 4096;

export class BellowsError extends Error {}

export function fail(line: number, message: string): never {
    throw new BellowsError(`.bellows.yaml line ${line}: ${message}`);
}

/**
 * A scalar: bare, 'single' or "double" quoted. No escapes — a command that needs one is a script
 * in the repo, not an inline one-liner.
 */
export function scalar(line: number, raw: string, what: string): string {
    const value = raw.trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
        if (!value.endsWith(quote) || value.length < 2) {
            fail(line, `${what}: unclosed ${quote === '"' ? 'double' : 'single'} quote`);
        }
        return value.slice(1, -1);
    }
    return value;
}

/** `key: value` / `key:` — the key shape is fixed, the value may contain colons. */
export const KEY_VALUE = /^([A-Za-z][A-Za-z0-9_]*):(?:(\s+)(.*))?$/;
