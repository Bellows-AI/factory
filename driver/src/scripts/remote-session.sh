# Read the bridge record out of a running runner's session transcript: the Remote Control id is
# printed into a TUI, never onto stdout, so the transcript is the only place it is legible, and
# reading it inside the container avoids having to locate the auth volume on the host.
#
# The session id arrives as the shell's FIRST POSITIONAL PARAMETER ($1) — a plain argv value,
# never interpolated into this text; the driver asserts it is a uuid before building the argv.
# The glob over projects/ rather than a derived directory slug: the CLI builds that directory
# name itself, and reimplementing the rule here would break silently the day it changes. The
# file name is the session id, which is unique enough on its own.
cat "$CLAUDE_CONFIG_DIR"/projects/*/"$1".jsonl 2>/dev/null | grep bridge-session | tail -1
