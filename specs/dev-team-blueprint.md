# Dev Team Blueprint

Status: draft, updated 2026-10-25
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
  bin/devteam            # CLI: up, down, status (and the internal heartbeat)
  team.toml              # default team settings: max_agents, heartbeat_minutes, director
  roles/                 # base roles, settings in +++ TOML frontmatter
    director.md
    builder.md
    reviewer.md
    tester.md
  templates/
    AGENTS.md            # starter file for new projects
```

The blueprint is a template. `devteam up` copies `team.toml` and `roles/` into the project the first time, and only copies files the project does not have yet. From then on the director and `devteam` read only the project's copies. Nothing in a project points back at the blueprint, so a project can change its roles freely and blueprint updates never leak into a running project.

## Project layout

```
.devteam/
  team.toml              # team settings, copied from the blueprint
  roles/                 # all roles the project uses, copied from the blueprint, then owned by the project
  vision.md              # goals, non-goals, constraints, decisions
  context.md             # rulebook for workers: Checks, Definition of done, Known flaky, Conventions
  state.md               # everything the director needs to resume after a restart or compaction
  team.md                # live roster: agent name, role, pane, worktree, task, status
  tasks/<id>.md          # one file per task
  tasks/<id>/            # handoffs: build.md, review-<role>.md, test.md
  questions.md           # questions for the human, open and closed
  retro.md               # one entry per finished task, each ending in an outcome
  log.md                 # director's decisions, append only
  session.json           # workspace and pane ids for down and status, gitignored
```

## CLI

Agent names are unique per herdr server, so every agent is named `<project-slug>-<role>[-<n>]`, for example `myapp-director` and `myapp-builder-1`.

### `devteam up [path] [--new]`

1. Check herdr, git, node and the hearth env.
2. If `--new`: create `path`, run `git init`, copy `templates/AGENTS.md`, make an initial commit.
3. Create missing `.devteam/` files, and copy missing `team.toml` and role files from the blueprint. Never modify files outside `.devteam/` in an existing repo.
4. Check every agent CLI named in the project's roles, and that the director role is `kind = "claude"`.
5. Create a herdr workspace for the project, with `HEARTH_URL` and `HEARTH_TOKEN` in its env.
6. Start the director in the root pane with the hearth MCP server. If a startup dialog appears, wait up to 5 minutes for the human to answer it.
7. Start the hearth runner in a pane: `RUNNER_HERDR_AGENT=<slug>-director RUNNER_TRIGGER=owner node <hearth>/runner/index.ts`.
8. Start the heartbeat in a pane.
9. Send the kickoff: the project's director role path, team settings, project path, agent name, worker prefix, pane, workspace and the human's hearth username. Resend up to 3 times if the director does not start working on it. The first prompt after a startup dialog closes can be dropped.

Running `up` on a project whose director is already live prints its status and exits.

### `devteam down [path] [--force]`

Remove the team's worktrees, close agent panes outside the project workspace, close the project workspace, reset `team.md`. Everything else in `.devteam/` stays. Without `--force`, worktrees with uncommitted changes are kept and reported.

### `devteam status [path]`

Print the director's state, `team.md`, task counts by status and the number of open questions.

### Heartbeat

The director wakes only on events: a worker report or a hearth message. If every worker stalls, for example after the Mac sleeps, no event arrives. The heartbeat closes that gap. Every `heartbeat_minutes`, if the director is idle and has workers, it prompts the director with `heartbeat`. The director then reads every worker's pane and treats one whose screen has not changed since the last check as stalled.

## Director

`roles/director.md` is the full specification of the director's behavior. Summary:

1. Plans, hires, assigns, judges and merges. Never edits product code or runs builds or tests. Writes only in `.devteam/`.
2. Keeps the project aligned with `vision.md`. Full authority otherwise. Asks the human on hearth only when the vision does not cover a decision, should change, or a worker needs something only the human can give. Asking never stops other work.
3. Keeps `state.md` current enough to resume from it alone.
4. Keeps `context.md` as the workers' rulebook. Checks are the exact commands workers run, matched to CI when the project has CI. Definition of done is what must pass on main after a merge: CI if present, otherwise the Checks run by a tester. Known flaky lists intermittent tests, each with a reason and tracking item.
5. Hires from `.devteam/roles/`, edits roles or writes new ones as the project needs, and logs why.
6. Each task lists the reviews it needs (`reviews: [...]`), which run in parallel, and its test role. A review or test may be skipped only when the change cannot affect what it checks, with the reason logged.
7. Task flow: `queued -> building -> reviewing -> testing -> merged -> done`. A task is `done`, and announced, only after main passes the definition of done. If main fails, a fix task goes to the front of the queue and nothing else merges until main passes.
8. After each task is done or dropped, writes a retro entry ending in a `context.md` line, a role change, or a new task. A problem seen a second time must get one of those.
9. Never runs more than `max_agents` workers. Extra tasks queue.

## Accepted risks

- **R2.** Tested 2026-10-24 (herdr 0.9.3, Claude Code 2.1.310, codex). A `herdr agent prompt` sent to a working agent is accepted by both. Claude finished its current turn, then answered the new message. Codex dropped its current turn at once and answered the new message instead. So the director must run on claude, and `devteam up` rejects any other kind for the director role. The director prompts workers only when they are idle, so the codex reviewer is not affected.

- **R1.** With no approval gates, a director-written role could weaken a check, such as a reviewer that passes too easily. Mitigation is visibility: every project role is a file in git and every role change is logged in `log.md`.

## Acceptance criteria

1. `devteam up --new /tmp/x` creates a git repo with `.devteam/` and a live director in a herdr workspace, and the director asks the human for the vision.
2. `devteam up <existing repo>` changes no files outside `.devteam/`, and the director writes `context.md`.
3. Given a goal with two independent tasks, the director hires two builders in separate worktrees, and both run at once.
4. With `max_agents = 1`, the second task stays `queued` until the first is done.
5. A task merges only after every review in its `reviews` list and its test record a pass, or the skipped stage has a logged reason.
6. The director can write a project role, use it to hire a worker, and log why.
7. `devteam down` leaves no agents, worktrees, or project workspace behind, and keeps `.devteam/tasks/`.
8. A decision outside `vision.md` adds an entry to `questions.md`, sets only the affected tasks to `waiting`, and DMs the human on hearth. Unaffected tasks keep moving. A reply in the DM wakes an idle director, and the answer is appended to `vision.md`.
9. A worker finishing a task wakes an idle director without human input.
10. With an idle director and a stalled worker, the heartbeat wakes the director within `heartbeat_minutes`, and the director resends or replaces the worker.
11. Missing `herdr`, `git`, a cataloged agent CLI, or `HEARTH_URL`/`HEARTH_TOKEN` makes `devteam up` exit non-zero, naming the missing tool.
12. After `up`, no file in `.devteam/` references the blueprint path, and the kickoff names only project files.
13. A task is announced only after main passes the definition of done.
