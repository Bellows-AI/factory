/**
 * The docker runner's wall-clock kill timer for one run, extendable while it runs: a question the
 * agent asked pushes the deadline out by the wait's cap (issue #226). The kubernetes executor's
 * counterpart is the kubelet's `activeDeadlineSeconds`, patched by `k8s-runner.ts`.
 */
export interface RunDeadline {
    /** Re-arms the timer to its remaining time plus `ms`. A deadline that already fired or was cleared stays so. */
    extend(ms: number): void;
    clear(): void;
}

export function startDeadline(ms: number, onFire: () => void): RunDeadline {
    let dueAt = Date.now() + ms;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
        timer = setTimeout(
            () => {
                live = false;
                onFire();
            },
            Math.max(0, dueAt - Date.now())
        );
    };
    arm();
    return {
        extend(extra) {
            if (!live) return;
            clearTimeout(timer);
            dueAt += extra;
            arm();
        },
        clear() {
            live = false;
            clearTimeout(timer);
        },
    };
}

/** The deadlines of the runs in flight, by lease token — the per-attempt identity. Clearing one also forgets it. */
export interface DeadlineRegistry {
    start(token: string, ms: number, onFire: () => void): RunDeadline;
    extend(token: string, ms: number): void;
}

export function createDeadlineRegistry(): DeadlineRegistry {
    const live = new Map<string, RunDeadline>();
    return {
        start(token, ms, onFire) {
            const deadline = startDeadline(ms, onFire);
            live.set(token, deadline);
            return {
                extend: (extra) => deadline.extend(extra),
                clear() {
                    deadline.clear();
                    if (live.get(token) === deadline) live.delete(token);
                },
            };
        },
        extend: (token, ms) => live.get(token)?.extend(ms),
    };
}
