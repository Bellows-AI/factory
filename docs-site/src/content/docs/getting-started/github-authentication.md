---
title: GitHub authentication
description: Configure Factory's GitHub App, OAuth App, installation onboarding, and webhook.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/getting-started/github-authentication.md
---

Factory uses two separate GitHub registrations. They solve different trust problems and must not be
collapsed into one credential.

## GitHub App: repositories and organizations

Create a GitHub App with these permissions:

- Metadata: read (repository), for the repository list.
- Contents: read (repository), so the dashboard and runners can clone private source.
- Pull requests: read (repository), required to subscribe to the `pull_request`,
  `pull_request_review`, and `pull_request_review_comment` webhook events below.
- Issues: read (repository), required to subscribe to the `issue_comment` webhook event below.
- Members: read (organization), required to subscribe to the `organization` webhook event below.

Publishing needs write access on top of that. If runners should push commits, open pull requests,
or read CI results, grant more on the installation: Contents: write, Pull requests: write, and
Actions: read. The token handed to each run
carries the installation's permissions, and Factory cannot grant what the installation lacks.

Install the App on each organization and repository Factory should see. The installation is both the
read credential and the repository inventory, so there is no separate repository-list setting.

Configure the App's Setup URL as:

```text
<PUBLIC_URL>/api/auth/github/setup
```

Generate a private key and configure `GITHUB_APP_ID` plus either the PEM/base64 value in
`GITHUB_APP_PRIVATE_KEY` or a path in `GITHUB_APP_PRIVATE_KEY_FILE`.

Configure the App webhook URL as `<PUBLIC_URL>/api/github/webhook`, set a 32-character-or-longer
`GITHUB_WEBHOOK_SECRET`, and subscribe to the `organization`, `pull_request`,
`pull_request_review`, `pull_request_review_comment`, and `issue_comment` events. Organization
events remove a member promptly instead of at their next sign-in; the pull request events drive
tasks that wait on pull request activity. Without a webhook secret the route does not exist.

## OAuth App: human sign-in

Create a separate OAuth App. Set its callback URL to:

```text
<PUBLIC_URL>/api/auth/github/callback
```

Set `AUTH_MODE=github`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`,
`PUBLIC_URL`, and `JOB_BOARD_TOKEN`. Use `COOKIE_SECURE=1` behind HTTPS. Sign-in requests only the
org-level `read:org` scope, so GitHub can report the account's App installations; it reads no
repository data. Organization membership comes from visible GitHub App installations.

## First sign-in

What happens on first sign-in depends on how many installations the account can see. With none,
Factory sends the account to the App's install page. With one, it signs straight in to that
organization. With two or more, it asks the account to choose which to track, and for every selected
organization, to choose either all current and future repositories or an explicit repository list.
Any account can reopen the chooser later from the tracked-organizations panel on the Account page. That choice materializes the organizations, memberships, and tracked telemetry scope available to
the session. It does not clone anything: personal checkout selection and provisioning happen later from
the Workspace settings page.

Rotating `SESSION_SECRET` logs everyone out. Rotating `JOB_BOARD_TOKEN` requires changing the board
and driver together and restarting both.
