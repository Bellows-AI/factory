// OpenCode's step boundary for a cooperative Stop (issue #442). Baked as a plugin: when the stop
// marker the stop poller writes exists, it aborts the session at the end of a model step (the
// step-finish part) or after a tool call, so no further model request is made. Reads only the
// marker — never the control credential. Aborting is the chosen mechanism because throwing from
// `tool.execute.before` shows the model a tool error and it keeps going. Fails open: any error
// leaves the run going, and the driver's grace kill is the backstop.
import { existsSync } from 'node:fs';

const DEFAULT_MARKER = '/tmp/factory-stop';
const STEP_FINISH = 'step-finish';
const PART_UPDATED = 'message.part.updated';

export const FactoryStopPlugin = async ({ client }) => {
    const aborted = new Set();
    const stopIfRequested = async (sessionID) => {
        if (!sessionID || aborted.has(sessionID)) return;
        if (!existsSync(process.env.FACTORY_STOP_MARKER || DEFAULT_MARKER)) return;
        aborted.add(sessionID);
        try {
            await client.session.abort({ path: { id: sessionID } });
        } catch (e) {
            // Said once on stderr: a wrong SDK call shape would otherwise silently leave every
            // Stop to the driver's grace kill.
            console.error(`factory-stop: could not abort session ${sessionID}: ${e?.message ?? e}`);
            aborted.delete(sessionID);
        }
    };
    return {
        event: async ({ event }) => {
            const part = event?.type === PART_UPDATED ? event.properties?.part : null;
            if (part?.type === STEP_FINISH) await stopIfRequested(part.sessionID);
        },
        'tool.execute.after': async (input) => {
            await stopIfRequested(input?.sessionID);
        },
    };
};

export default FactoryStopPlugin;
