---
name: jira
description: Read, search, create and comment on Jira work items through Jira's REST API with curl, against the $JIRA_API base the entrypoint exports. Use whenever a Jira issue key (ABC-1234), a *.atlassian.net/browse/ URL, or a request to look up, update or comment on a ticket appears. Also covers Jira authentication failures. Do not use an Atlassian MCP server or acli — curl on $JIRA_API is the supported path here.
metadata:
  requires-tools: curl
  requires-connections: jira
---

# Jira through the REST API

Reach Jira with `curl` against `$JIRA_API`, the board's connector for this task. You hold no Jira
credential: the board adds the task's authorized connection to each call, and only while this
attempt is running. Your run's own pair, `$RUNNER_JOB_ID` and `$RUNNER_LEASE_TOKEN`, is what the
board checks. The Atlassian MCP server is deliberately not configured, and `acli` cannot use this
connection — do not use either.

Given a URL like `https://SITE.atlassian.net/browse/ABC-1234`, extract the key and read it through
`$JIRA_API` rather than fetching the page. Never put the lease token in a URL or echo it.

## Commands

Every call is one self-contained command; shell state does not carry between them. The pair
reaches curl as headers in a config on stdin from `printf`, a shell builtin, because an argv shows
in any process listing — never pass the token as a `-H` argument or in a URL.

```bash
# Full detail, including the comment thread
printf 'header = "x-factory-job-id: %s"\nheader = "x-factory-job-lease-token: %s"\n' "$RUNNER_JOB_ID" "$RUNNER_LEASE_TOKEN" | curl -K - -sS --fail-with-body -H 'Accept: application/json' \
    "$JIRA_API/issue/<KEY>?fields=summary,description,status,issuetype,parent,fixVersions,components,labels,comment"

# Search by JQL
printf 'header = "x-factory-job-id: %s"\nheader = "x-factory-job-lease-token: %s"\n' "$RUNNER_JOB_ID" "$RUNNER_LEASE_TOKEN" | curl -K - -sS --fail-with-body -H 'Accept: application/json' -G \
    --data-urlencode "jql=project = ABC AND status = 'In Progress' ORDER BY updated DESC" \
    --data-urlencode "fields=summary,status,issuetype,parent,fixVersions,components,labels" \
    "$JIRA_API/search/jql"

# Comment — the body is Atlassian Document Format, not plain text
printf 'header = "x-factory-job-id: %s"\nheader = "x-factory-job-lease-token: %s"\n' "$RUNNER_JOB_ID" "$RUNNER_LEASE_TOKEN" | curl -K - -sS --fail-with-body -H 'Content-Type: application/json' \
    -X POST "$JIRA_API/issue/<KEY>/comment" \
    -d '{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"..."}]}]}}'

# Create
printf 'header = "x-factory-job-id: %s"\nheader = "x-factory-job-lease-token: %s"\n' "$RUNNER_JOB_ID" "$RUNNER_LEASE_TOKEN" | curl -K - -sS --fail-with-body -H 'Content-Type: application/json' \
    -X POST "$JIRA_API/issue" \
    -d '{"fields":{"project":{"key":"ABC"},"issuetype":{"name":"Task"},"summary":"..."}}'
```

`assignee = currentUser()` matches the connection's own account, not a person.

## Reading a ticket properly

- **Always read the comments.** Clarifications and changed requirements land there, not in the
  description.
- **A subtask is not self-contained.** If `issuetype.subtask` is true or `parent` is non-null,
  fetch the parent too; the actual requirement usually lives there.
- Name the fields you need. `description` and comment bodies come back as ADF JSON: read the
  `text` nodes.

## Authentication

If `JIRA_API` is empty, or a call answers 401/403, **stop and report it** — quote the `error`
message the board returned, which says what to fix (no connection selected, connection deleted or
no longer authorized, read-only connection) — do not retry, and do not work around it by guessing
ticket contents. Loading this skill never grants access; only the connection the task was started
with does.
