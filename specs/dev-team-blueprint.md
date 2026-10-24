# Dev Team Blueprint

Status: draft, 2026-10-24
Open items: none

## Goal

Start a team of coding agents on any project with one command. A director agent runs in herdr, hires workers from a role catalog as the work needs them, hands them tasks, judges results, and merges finished work.

## Dependencies

- herdr (0.9.3 or later)
- git
- python3 3.11 or later (runs `bin/devteam`)
- node (runs the hearth MCP server and runner)
- The agent CLIs named in the role catalog (default: `claude`, `codex`)
- hearth: an agent account for the director, its MCP server, and its runner. Env: `HEARTH_URL`, `HEARTH_TOKEN`, `HEARTH_HUMAN` (the human's hearth username), `HEARTH_DIR` (default `~/workspace/hearth`)

No other tools. `devteam up` checks each dependency and exits with the name of anything missing.

## Decisions

| Code | Decision |
|------|----------|
| D1 | A script starts only the director. The director hires the rest. |
| D2 | The director pushes work with `herdr agent prompt`. Workers do not poll. |
| D3 | Each role sets its agent kind and model. Default reviewer is codex, all others claude. |
| D4 | No approval gates. The director keeps the project aligned with `vision.md` and asks the human only to clarify or change the vision. |
| D5 | A role catalog plus project roles. No fixed team presets. |
| Q1 | Supports new projects and existing repos. |
| Q2 | The lead is a director agent. It never edits code. |
| Q3 | Ship our own role prompts in `roles/`. No dependency on `software-factory`. |
| Q4 | Director starts from the catalog and may customize or write project roles. |
| Q5 | Work beyond `max_agents` queues. |

## Blueprint repo layout

```
dev-team/
  bin/devteam            # CLI: up, down, status
  team.toml              # defaults: limits, director role
  roles/                 # base catalog
    director.md
    builder.md
    reviewer.md
    tester.md
  templates/
    AGENTS.md            # starter file for new projects
```

## Project layout

`devteam up` creates this in the target repo:

```
.devteam/
  vision.md              # the decided vision: goals, non-goals, constraints, decisions
  context.md             # repo facts the director gathers: stack, build, test commands
  team.md                # live roster: agent name, role, pane, worktree, task, status
  roles/                 # project roles, override catalog roles of the same name
  tasks/<id>.md          # one file per task
  tasks/<id>/            # handoff files: spec.md, build.md, review.md, test.md
  questions.md           # open questions for the human, with answers when given
  log.md                 # director's decisions, append only
  session.json           # workspace and pane ids for down and status, gitignored
```

## CLI

Agent names are unique per herdr server, so every agent is named `<project-slug>-<role>[-<n>]`, for example `myapp-director` and `myapp-builder-1`.

### `devteam up [path] [--new]`

1. Check dependencies.
2. If `--new`: create `path`, run `git init`, copy `templates/AGENTS.md`, make an initial commit.
3. Create `.devteam/` if missing. Never modify files outside it in an existing repo.
4. Create a herdr workspace for the project, cwd = repo root.
5. Start the director in the root pane: `herdr agent start <slug>-director --kind <kind> --pane <pane>`, with the hearth MCP server configured from `HEARTH_URL` and `HEARTH_TOKEN`.
6. Prompt the director with its role file, the catalog path, `team.toml` limits, and the project path.
7. Split a pane and start the hearth runner in it: `RUNNER_HERDR_AGENT=<slug>-director RUNNER_TRIGGER=owner node <hearth>/runner/index.ts`.

Running `up` on a project whose director is already live prints its status and exits.

### `devteam down [path]`

Stop every agent listed in `team.md`, remove their worktrees, close the project workspace. Task files and logs stay.

### `devteam status [path]`

Print `team.md` and task counts by status.

## team.toml

```toml
max_agents = 4               # workers running at once, director excluded
catalog = "roles"            # path to base catalog
director = "director"        # role used for the director

[roles.builder]
kind = "claude"
model = "claude-opus-5-5"
reset = "/clear"             # command that clears context between tasks
worktree = true
when = "Implements one task in its own worktree."

[roles.reviewer]
kind = "codex"
reset = "/new"
worktree = false             # reads the builder's worktree
when = "Reviews a finished task's diff for correctness and simplicity."

[roles.tester]
kind = "claude"
model = "claude-sonnet-5-5"
reset = "/clear"
worktree = false
when = "Runs and extends tests for a finished task."
```

A project role in `.devteam/roles/<name>.md` may carry the same fields as TOML frontmatter. Missing fields fall back to the catalog entry of the same name.

## Director

### Rules

1. Never edits code, runs builds, or runs tests. Writes only inside `.devteam/`.
2. Owns alignment with `vision.md`. Every task, hire, custom role, and merge must serve it.
3. The only agent that changes a task's status or edits `team.md`.
4. Merges a task only after its reviewer and tester both pass it.
5. Records every hire, release, custom role, and merge in `log.md` with one line of reasoning.

### Startup

1. On an existing repo, read README, `AGENTS.md`/`CLAUDE.md`, and build/test config. Write `.devteam/context.md`.
2. If `vision.md` is missing or too thin to plan from, work with the human to write it.
3. Break the vision into tasks.

### Hiring a worker

1. Pick a role from `.devteam/roles/`, then the catalog. If none fits, write a project role and log why.
2. If the role uses a worktree: `herdr worktree create --cwd <repo> --branch devteam/<task-id> --no-focus`. Use the returned workspace's root pane.
   Otherwise: `herdr pane split --pane <director pane> --direction right --cwd <repo> --no-focus`.
3. `herdr agent start <role>-<n> --kind <kind> --pane <pane>`.
4. Prompt with the role file and the task path.
5. Add a row to `team.md`.

### Assigning work

1. `herdr agent prompt <name> "<task path>"` without `--wait`, so one worker never holds up the director.
2. Every worker's last step on a task is `herdr agent prompt director "<task-id> ready: <handoff path>"`. Every role prompt includes this step. It wakes the director if it is idle.
3. When the director has nothing left to do, it ends its turn. A worker report or a hearth DM wakes it.
4. On a worker report, read the task's handoff file. If missing or unclear, `herdr agent read <name>`.
5. On each wake, check `herdr agent list` for workers that went `idle` without reporting.
6. On `blocked`, read the agent's screen and decide. If it is a permission or approval prompt the director cannot judge, add a question (see Working with the human).
7. A free worker gets the next queued task of its role. Send the role's `reset` command first.

### Task flow

```
queued -> building -> reviewing -> testing -> merged
             ^            |           |
             +--- rework -+-----------+
any state -> waiting -> back to prior state once its question is answered
any state -> dropped
```

A task enters `building` only when every task in its `depends_on` is `merged`, it has no open question, and a worker slot is free.

### Working with the human

The director has full authority over tasks, hires, roles, and merges. It goes to the human only when:

1. A decision is not covered by `vision.md`, or the vision is ambiguous on it.
2. Work shows the vision itself should change.
3. A worker is blocked on something only the human can provide, such as credentials or a permission prompt.

Asking never stops the director:

1. Add the question to `questions.md` with an id (`q1`, `q2`, ...) and the tasks it blocks.
2. Set those tasks to `waiting` with `question: <id>` in their frontmatter.
3. DM the human on hearth with `send_message`: `<project> <id>: <question>`.
4. Keep working on every task the question does not block.

The human replies in the same DM. If the director is idle, the hearth runner prompts it with the reply. If it is busy, the runner tells the human to ask again later. The director doesn't depend on that retry: on every wake it reads the DM with `read_messages` and picks up any answers. When a question has an answer, the director records it in `vision.md` under Decisions, marks it closed in `questions.md`, and returns its tasks to their prior state.

The director also uses the DM for status updates the human should see, such as a merged task or a hired role. It keeps them to one line each.

### Releasing a worker

When no queued task fits its role, the director sends the agent an exit, removes its worktree with `herdr worktree remove --workspace <id>`, and deletes its `team.md` row.

### Limits

Running workers never exceed `max_agents`. Extra tasks stay `queued` (Q5).

## Task file

```markdown
---
id: t003
title: Add login rate limiting
status: queued
role: builder
owner: builder-1
depends_on: [t001]
branch: devteam/t003
---

## Acceptance criteria
1. ...
```

Workers write only to their task's handoff directory and, for builders, their worktree.

## Accepted risks

- **R2.** Tested 2026-10-24 (herdr 0.9.3, Claude Code 2.1.310, codex). A `herdr agent prompt` sent to a working agent is accepted by both. Claude finished its current turn, then answered the new message. Codex dropped its current turn at once and answered the new message instead. So the director must run on claude, and `devteam up` rejects any other kind for the director role. The director prompts workers only when they are idle, so the codex reviewer is not affected.

- **R1.** With no approval gates, a director-written role could weaken a check, such as a reviewer that passes too easily. Mitigation is visibility: every project role is a file in git and every role change is logged in `log.md`.

## Acceptance criteria

1. `devteam up --new /tmp/x` creates a git repo with `.devteam/` and a live director in a herdr workspace, and the director asks the human for the vision.
2. `devteam up <existing repo>` changes no files outside `.devteam/`, and the director writes `context.md`.
3. Given a goal with two independent tasks, the director hires two builders in separate worktrees, and both run at once.
4. With `max_agents = 1`, the second task stays `queued` until the first is merged.
5. A task merges only after `review.md` and `test.md` both record a pass.
6. The director can write a project role, use it to hire a worker, and log why.
7. `devteam down` leaves no agents, worktrees, or project workspace behind, and keeps `.devteam/tasks/`.
8. A decision outside `vision.md` adds an entry to `questions.md`, sets only the affected tasks to `waiting`, and DMs the human on hearth. Unaffected tasks keep moving. A reply in the DM wakes an idle director, and the answer is appended to `vision.md`.
9. A worker finishing a task wakes an idle director without human input.
10. Missing `herdr`, `git`, a cataloged agent CLI, or `HEARTH_URL`/`HEARTH_TOKEN` makes `devteam up` exit non-zero, naming the missing tool.
