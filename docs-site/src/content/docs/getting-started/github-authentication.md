---
title: GitHub authentication
description: Configure Factory's GitHub App, OAuth App, installation onboarding, and webhook.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/getting-started/github-authentication.md
---

Factory uses two separate GitHub registrations. They solve different trust problems and must not be
collapsed into one credential.

## GitHub App: repositories and organizations

Create a GitHub App with these repository permissions:

- Metadata: read.
- Pull requests: read.
- Contents: read. This is required for the revert metric; other telemetry can operate without it.

Install the App on each organization and repository Factory should see. The installation is both the
read credential and the repository inventory, so there is no separate repository-list setting.

Configure the App's Setup URL as:

```text
<PUBLIC_URL>/api/auth/github/setup
```

Generate a private key and configure `GITHUB_APP_ID` plus either the PEM/base64 value in
`GITHUB_APP_PRIVATE_KEY` or a path in `GITHUB_APP_PRIVATE_KEY_FILE`.

For prompt membership removal, configure the App webhook URL as
`<PUBLIC_URL>/api/github/webhook`, set a 32-character-or-longer `GITHUB_WEBHOOK_SECRET`, and subscribe
to organization events.

## OAuth App: human sign-in

Create a separate OAuth App. Set its callback URL to:

```text
<PUBLIC_URL>/api/auth/github/callback
```

Set `AUTH_MODE=github`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`,
`PUBLIC_URL`, and `JOB_BOARD_TOKEN`. Use `COOKIE_SECURE=1` behind HTTPS. Factory requests no OAuth
scopes; organization membership comes from visible GitHub App installations.

## First sign-in

On first sign-in, Factory asks the account to choose from the installations it can see. For every
selected organization, choose either all current and future repositories or an explicit repository
list. That choice materializes the organizations, memberships, and tracked telemetry scope available to
the session. It does not clone anything: personal checkout selection and provisioning happen later from
the Workspace settings page.

Rotating `SESSION_SECRET` logs everyone out. Rotating `JOB_BOARD_TOKEN` requires changing the board
and driver together and restarting both.
