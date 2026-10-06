#!/usr/bin/env node
'use strict';
// The claim's per-node turn context (issue #509): the baked UserPromptSubmit hook. The driver puts
// it in FACTORY_TURN_CONTEXT; answered as additional context it lands beside this run's prompt, so
// the system prompt stays the same across a thread's node transitions and `-p` stays the command —
// a `/skill` command must come first to expand. Says nothing when the claim carried none.
const turnContext = process.env.FACTORY_TURN_CONTEXT;

if (turnContext) {
    process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: turnContext } })}\n`
    );
}
