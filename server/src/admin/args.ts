/**
 * `--key value` and `--flag`, and nothing else.
 *
 * Hand-rolled rather than a dependency: these two tools take seven options between them, and the
 * whole parser is shorter than the argument for choosing a library would be.
 */
export function parseArgs(argv: readonly string[]): Record<string, string | true> {
    const out: Record<string, string | true> = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]!;
        if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`);
        const key = arg.slice(2);
        if (!key) throw new Error('empty option name');
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            out[key] = true;
        } else {
            out[key] = next;
            i += 1;
        }
    }
    return out;
}

/** A required option's value, refusing a bare flag — `--login` with nothing after it is a typo. */
export function value(args: Record<string, string | true>, key: string): string | null {
    const raw = args[key];
    if (raw === undefined) return null;
    if (raw === true) throw new Error(`--${key} needs a value`);
    return raw.trim() || null;
}
