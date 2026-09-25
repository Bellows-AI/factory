---
name: jira
description: Read, search, create and comment on Jira work items with the Atlassian CLI (acli), which is installed in this image. Use whenever a Jira issue key (ABC-1234), a *.atlassian.net/browse/ URL, or a request to look up, update or comment on a ticket appears. Also covers acli authentication failures. Do not use an Atlassian MCP server — acli is the supported path here.
---

# Jira through acli

`acli` is at `/usr/local/bin/acli`. It is the only supported way to reach Jira from this container;
the Atlassian MCP server is deliberately not configured.

Given a URL like `https://SITE.atlassian.net/browse/ABC-1234`, extract the key and read it with
`acli` rather than fetching the page.

## Commands

```bash
# What am I working on
acli jira workitem search \
    --jql "assignee = currentUser() AND status = 'In Progress' ORDER BY updated DESC" \
    --fields "key,summary,status,issuetype,parent,fixVersions,components,labels" \
    --json

# Full detail, including the comment thread
acli jira workitem view <KEY> \
    --fields "key,summary,description,status,issuetype,parent,fixVersions,components,labels,comment" \
    --json

acli jira workitem create
acli jira workitem comment <KEY> --body "..."
```

## Reading a ticket properly

- **Always read the comments.** Clarifications and changed requirements land there, not in the
  description — a ticket read without its comments is routinely out of date.
- **A subtask is not self-contained.** If `issuetype.subtask` is true or `parent` is non-null,
  fetch the parent too; the actual requirement usually lives there.
- Prefer `--json` and name the fields you need. The default human output is wordy and the extra
  fields cost context for nothing.

## Authentication

`acli` reads credentials from `~/.config/acli`, which is not baked into the image. When the run's
environment carries `ATLASSIAN_SITE`, `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN`, the entrypoint
has already logged in before you started; otherwise the container is unauthenticated. On any auth
failure, **stop and report it** — name the three variables as the fix — do not retry, and do not
work around it by guessing ticket contents.
