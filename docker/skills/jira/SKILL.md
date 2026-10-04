---
name: jira
description: Read, search, create and comment on Jira work items through Jira's REST API with curl, against the $JIRA_API base the entrypoint exports. Use whenever a Jira issue key (ABC-1234), a *.atlassian.net/browse/ URL, or a request to look up, update or comment on a ticket appears. Also covers Jira authentication failures. Do not use an Atlassian MCP server or acli — curl on $JIRA_API is the supported path here.
---

# Jira through the REST API

Reach Jira with `curl` against `$JIRA_API`, authenticated as `$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN`.
The Atlassian MCP server is deliberately not configured, and `acli` cannot use the scoped
(service-account) token this container carries — do not use either.

Given a URL like `https://SITE.atlassian.net/browse/ABC-1234`, extract the key and read it through
`$JIRA_API` rather than fetching the page. Never put the token in a URL or echo it.

## Commands

Every call is one self-contained command; shell state does not carry between them.

```bash
# Full detail, including the comment thread
curl -sS --fail-with-body -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" -H 'Accept: application/json' \
    "$JIRA_API/issue/<KEY>?fields=summary,description,status,issuetype,parent,fixVersions,components,labels,comment"

# Search by JQL
curl -sS --fail-with-body -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" -H 'Accept: application/json' -G \
    --data-urlencode "jql=project = ABC AND status = 'In Progress' ORDER BY updated DESC" \
    --data-urlencode "fields=summary,status,issuetype,parent,fixVersions,components,labels" \
    "$JIRA_API/search/jql"

# Comment — the body is Atlassian Document Format, not plain text
curl -sS --fail-with-body -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" -H 'Content-Type: application/json' \
    -X POST "$JIRA_API/issue/<KEY>/comment" \
    -d '{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"..."}]}]}}'

# Create
curl -sS --fail-with-body -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" -H 'Content-Type: application/json' \
    -X POST "$JIRA_API/issue" \
    -d '{"fields":{"project":{"key":"ABC"},"issuetype":{"name":"Task"},"summary":"..."}}'
```

`assignee = currentUser()` matches the token's own account — a service account — not a person.

## Reading a ticket properly

- **Always read the comments.** Clarifications and changed requirements land there, not in the
  description.
- **A subtask is not self-contained.** If `issuetype.subtask` is true or `parent` is non-null,
  fetch the parent too; the actual requirement usually lives there.
- Name the fields you need. `description` and comment bodies come back as ADF JSON: read the
  `text` nodes.

## Authentication

When the run's environment carries `ATLASSIAN_SITE`, `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN`,
the entrypoint resolved the site's cloud id and exported `JIRA_API` before you started. If
`JIRA_API` is empty, or a call answers 401/403, **stop and report it** — name the three variables
(and, on 403, the token's Jira scopes) as the fix — do not retry, and do not work around it by
guessing ticket contents.
