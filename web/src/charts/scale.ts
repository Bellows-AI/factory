export const PAD = { top: 16, right: 48, bottom: 40, left: 48 };

export type Scale = (value: number) => number;

export function linearScale([d0, d1]: [number, number], [r0, r1]: [number, number]): Scale {
    const span = d1 - d0 || 1;
    return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

export function logScale([d0, d1]: [number, number], [r0, r1]: [number, number]): Scale {
    const lo = Math.log10(Math.max(d0, 1));
    const hi = Math.log10(Math.max(d1, 10));
    const span = hi - lo || 1;
    return (value) => r0 + ((Math.log10(Math.max(value, 1)) - lo) / span) * (r1 - r0);
}

export function niceMax(value: number): number {
    if (!value || value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / magnitude) * magnitude;
}

const TICK_KILO_THRESHOLD = 1000;
/** Rounds to the nearest tenth of a thousand — `12345` renders as `12.3k`. */
const TICK_KILO_ROUNDING_STEP = 100;

export function formatTick(value: number): string {
    if (value >= TICK_KILO_THRESHOLD) return `${Math.round(value / TICK_KILO_ROUNDING_STEP) / 10}k`;
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(1);
}
