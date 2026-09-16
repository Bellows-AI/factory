/**
 * The exit code the docker daemon answers when IT refused to start or killed the container —
 * the platform's verdict, never the command's; the kubernetes runner harnesses its own
 * rejections into the same code, so both executors classify one shape.
 *
 * A leaf module on purpose: gates.ts owns the classification, while docker.ts and k8s.ts only
 * read the constant — and an import from either into gates.ts (or the reverse) would execute
 * the whole gate module, server included, inside another file's graph. The suite runs with
 * `isolate: false` (one shared module graph per worker), and gates.test.ts binds its node:http
 * wrap only when gates.js FIRST executes there; a cached copy from an earlier file's import
 * silently disarms that seam.
 */
export const CONTAINER_GONE = 125;
