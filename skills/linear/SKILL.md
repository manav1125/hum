---
name: linear
description: Work the user's Linear board — create, update, and comment on issues with ID resolution, mandatory dedupe before filing, and per-user attribution
compatibility: "Designed for Cue personal assistants"
metadata:
  icon: assets/icon.svg
  emoji: "🔷"
  vellum:
    category: "development"
    display-name: "Linear"
    user-invocable: true
    activation-hints:
      - "file this in linear"
      - "create a linear issue"
      - "update the linear board"
      - "sync my backlog to linear"
      - "When the user wants to create, update, search, or comment on Linear issues"
    avoid-when:
      - "When the user is connecting Linear or creating a Linear agent app for the first time (use linear-app-setup or vellum-oauth-integrations instead)"
---

# Linear

Operate the user's Linear workspace: file issues, move them through states, set priority and assignee, and comment — as a doing skill, not a setup flow. If no Linear connection exists yet (neither route below works), stop and point the user at **linear-app-setup** or **vellum-oauth-integrations**.

## Choosing a route

Two routes, in order of preference:

1. **Composio `LINEAR_*` tools (preferred, when provisioned).** When the Linear connector is connected, the `composio_linear` MCP server auto-provisions `LINEAR_*` tools (issue create/update/list, teams, projects, comments, …). If tools named `LINEAR_*` are available in this conversation, use them — pick the tool whose name matches the operation and follow its schema. They handle auth and pagination for you.
2. **Raw GraphQL fallback.** When no `LINEAR_*` tools are present, call the Linear GraphQL API through the managed OAuth connection (scopes `read`, `write`, `issues:create` are seeded):

```bash
assistant oauth request --provider linear \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name } }"}' \
  /graphql
```

The Authorization header is injected automatically — never supply it manually and never echo token values. All GraphQL examples below use this shape; only the `-d` payload changes. Everything in Linear's API is reachable this way.

## Resolve IDs first (and cache them)

Linear mutations take UUIDs, not names. Before the first mutation in a conversation, resolve what you need with **one or two queries**, then reuse the IDs for the rest of the conversation — do not re-query per issue.

```graphql
{
  teams {
    nodes {
      id
      key
      name
      states { nodes { id name type } }
      labels { nodes { id name } }
    }
  }
  projects(first: 50) { nodes { id name state } }
  users(first: 50) { nodes { id name email } }
}
```

- **Team**: required for every issue. If the user names one ("file it in Platform"), match by `name`/`key`; if there is exactly one team, use it silently; otherwise ask once and remember the answer.
- **States** (`workflowStates`) are **per-team** — a "Done" ID from one team is invalid in another. Match by `name`, fall back to `type` (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`).
- **Labels and projects**: match case-insensitively; never invent an ID. If a label the user wants doesn't exist, say so rather than guessing.
- **Priority** is an integer, no ID needed: 0 none, 1 urgent, 2 high, 3 normal, 4 low.

## Dedupe before create — MANDATORY

**Never refile the same item.** Before every `issueCreate`, search for an existing issue:

- If you have an identifier (`ENG-123`), look it up directly: `{ issue(id: "ENG-123") { id identifier title state { name } url } }` (the `issue` query accepts identifiers as well as UUIDs).
- Otherwise search by title:

```graphql
query($term: String!) {
  searchIssues(term: $term, first: 10) {
    nodes { id identifier title state { name } url }
  }
}
```

(Composio route: use the issue list/search tool with the title as the filter.)

- **Match found and open** → do not create. Update or comment on the existing issue instead, and tell the user which issue it was (`identifier` + `url`).
- **Match found but done/canceled** → mention it and ask whether to reopen or file fresh (batch/scheduled runs: file fresh and note the prior issue in the description).
- **No match** → create.

This applies to every source — a chat request, a synced backlog row, a triage sweep. When syncing a batch (e.g. "sync my backlog to linear"), run the dedupe check per item and report created vs. already-present counts at the end.

## Create an issue

```graphql
mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}
```

with variables like:

```json
{
  "input": {
    "title": "Fix the login redirect loop",
    "description": "Steps to reproduce…  (markdown)",
    "teamId": "<team-uuid>",
    "stateId": "<state-uuid, optional>",
    "priority": 2,
    "labelIds": ["<label-uuid>"],
    "assigneeId": "<user-uuid, optional>",
    "projectId": "<project-uuid, optional>"
  }
}
```

Always report the created `identifier` and `url` back to the user.

### Attribution (raw GraphQL as an agent app)

When the connection is a Linear **agent app** and the action originated from a specific person, attribute it by adding `createAsUser` (display name) and optionally `displayIconUrl` (avatar URL) to the create input — it renders as "Jane (via AppName)" in Linear. Use it on `issueCreate` and `commentCreate`. Details in `skills/linear-app-setup/SKILL.md`.

## Update an issue (state / priority / assignee)

```graphql
mutation($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { identifier state { name } priority assignee { name } }
  }
}
```

- `$id` accepts the issue UUID or identifier (`ENG-123`).
- `input` takes any subset of `stateId`, `priority`, `assigneeId`, `labelIds`, `projectId`, `title`, `description`, `dueDate` — send only what changes.
- Remember: `stateId` must belong to the issue's team.

## Comment on an issue

```graphql
mutation($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}
```

with `{ "input": { "issueId": "<issue-uuid>", "body": "markdown body" } }`. Add `createAsUser` for attribution when acting for a specific person.

## Operating notes

- Confirm destructive-feeling changes (closing/canceling issues in bulk, reassigning someone else's issue) before doing them; single routine updates the user asked for need no extra confirmation.
- GraphQL errors come back with HTTP 200 — check the `errors` array in every response, and report Linear's message rather than a generic failure.
- Rate limits: batch reads (one query for many IDs) rather than looping single-item queries.
