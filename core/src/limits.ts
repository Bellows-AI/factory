/**
 * A command is a shell line, not a payload. 16 KiB is far past anything a human writes, and past
 * anything a generated one should be; the body limit is a little above it so an oversized command
 * is refused with a reason rather than a bare connection error. The workflow engine caps a
 * substituted prompt at the same number, so a thread never hands the driver what a create refuses.
 */
export const COMMAND_LIMIT = 16_384;
