# Dev Team Blueprint

Status: draft, updated 2026-10-25
Open items: none

## Goal

Start a team of coding agents on any project with one command. A director agent runs in herdr or Orca, hires workers from a role catalog as the work needs them, hands them tasks, judges results, and merges finished work.

## Dependencies

- herdr (0.9.3 or later) or Orca (1.4.240 or later)
- git
- python3 3.11 or later (runs `bin/devteam`)
- node, with hearth only (runs the hearth MCP server and runner)
- The agent CLIs named in the role catalog (default: `claude`, `codex`)
- hearth, optional: an agent account for the director, its MCP server, and its runner. Setting any `HEARTH_` variable turns it on, and then all of these are required. Without hearth, the director talks to the human in its own terminal. Env: `HEARTH_URL`, `HEARTH_TOKEN`, `HEARTH_HUMAN` (the human's hearth username), `HEARTH_DIR` (default `~/workspace/hearth`). Optional: `HEARTH_ALERTS`, the id of a hearth channel whose webhook posts the runner hands to the director as alerts

No other tools. `devteam up` checks each dependency and exits with the name of anything missing.

## Decisions

| Code | Decision |
|------|----------|
| D1 | A script starts only the director. The director hires the rest. |
| D2 | The director pushes work with `devteam prompt`. Workers do not poll. |
| D6 | herdr and Orca are interchangeable backends. Agents control each other only through `devteam` agent commands, never herdr or orca directly, so role files work on both. |
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
  bin/devteam            # CLI: up, down, status, agent commands (and the internal heartbeat)
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
  team.md                # live roster: agent name, role, worktree, task, status
  tasks/<id>.md          # one file per task
  tasks/<id>/            # handoffs: build.md, review-<role>.md, test.md
  questions.md           # questions for the human, open and closed
  retro.md               # one entry per finished task, each ending in an outcome
  log.md                 # director's decisions, append only
  session.json           # backend, and each agent's terminal ref, worktree, task and exit command, gitignored
```

## CLI

Agent names are unique per herdr server, so every agent is named `<project-slug>-<role>[-<n>]`, for example `myapp-director` and `myapp-builder-1`. Orca addresses terminals by handle, not name, so `session.json` maps each name to its herdr agent name or Orca terminal handle.

### Backends

`devteam up --backend herdr|orca` picks the backend. The default is the one the shell runs in (`ORCA_TERMINAL_HANDLE`, then `HERDR_ENV`), else whichever is installed. Every later command reads it from `session.json`.

| Operation | herdr | Orca |
|---|---|---|
| Director place | new herdr workspace | new terminal in the repo's Orca worktree. `orca repo add` registers the repo if needed |
| Start an agent | `herdr agent start <name> --kind <kind> --pane <pane> -- <args>` | `orca terminal create --title <name> --command "<kind> <args>"` |
| Worktree | `herdr worktree create --branch devteam/<id>` | `orca worktree create --name devteam/<id>`, then `git branch -m devteam/<id>`, since Orca prefixes the branch with the git user |
| Other agent | split of the director's pane | new terminal tab in the repo's worktree |
| Prompt | `herdr agent prompt` | `orca terminal send --text --enter` |
| Kickoff check | `herdr agent prompt --wait`, resend on `agent_prompt_stalled` | `orca terminal send --wait-submit 15`, resend without `turn_started` |
| Status | `herdr agent get` | `orca terminal wait --for tui-idle --timeout-ms 3000`: satisfied is idle, `blockedReason` is blocked, timeout is working |
| Read | `herdr agent read --source recent-unwrapped` | `orca terminal read` |
| Remove worktree | `herdr worktree remove --workspace <id>`, which also closes the agent's pane | `orca worktree rm`. Orca deletes the branch only when it can prove it is merged |
| Hearth runner | pane below the director | its own terminal in the repo's worktree |
| Heartbeat | pane below the runner | its own terminal in the repo's worktree |

### `devteam up [path] [--new]`

1. Check the backend CLI and git, plus node and the hearth env when hearth is on.
2. If `--new`: create `path`, run `git init`, copy `templates/AGENTS.md`, make an initial commit.
3. Create missing `.devteam/` files, and copy missing `team.toml` and role files from the blueprint. Never modify files outside `.devteam/` in an existing repo.
4. Check every agent CLI named in the project's roles, and that the director role is `kind = "claude"`.
5. Create the director's place (see Backends).
6. Start the director, with the hearth MCP server configured from `HEARTH_URL` and `HEARTH_TOKEN_FILE` when hearth is on. devteam writes `HEARTH_TOKEN` to a mode 600 file in a new mode 700 temp directory, so the token is never on a command line, in a terminal title or in `session.json`. `down` removes the directory. If a startup dialog appears, wait up to 5 minutes for the human to answer it.
7. With hearth only: start the hearth runner beside the director (see Backends), in the project, with the devteam engine from `hearth/devteam-engine.ts`: `env PATH=<dev-team>/bin:$PATH HEARTH_URL=... HEARTH_TOKEN_FILE=<token file> RUNNER_EXTENSIONS=<dev-team>/hearth/devteam-engine.ts RUNNER_ENGINE=devteam RUNNER_TRIGGER=owner DEVTEAM_AGENT=<slug>-director DEVTEAM_PROJECT=<repo> [RUNNER_ALERTS=$HEARTH_ALERTS] node <hearth>/runner/index.ts`. Its pane or terminal handle is saved as `runner` in `session.json`, and `down` closes it.
8. Start the heartbeat.
9. Send the kickoff: the project's director role path, team settings, the devteam CLI path, project path, agent name, worker prefix, and the human's hearth username or `No hearth`. Resend up to 3 times if the director does not start working on it. The first prompt after a startup dialog closes can be dropped.

Running `up` on a project whose director is already live prints its status and exits.

### `devteam down [path] [--force]`

Exit every agent in `session.json`, remove their worktrees and any other `devteam/` worktree, close the heartbeat and the herdr workspace, reset `team.md`. Everything else in `.devteam/` stays. Without `--force`, worktrees with uncommitted changes are kept and reported.

### `devteam status [path]`

Print the director's state, `team.md`, task counts by status and the number of open questions.

### Agent commands

The director and workers run these. They find the project from the cwd, including from a worker's worktree, through the main checkout's git dir.

| Command | Does |
|---|---|
| `devteam hire <name> <role> [--task <id>]` | Starts a worker with the role's settings. A `worktree = true` role gets a worktree on `devteam/<id>`, or one detached at its head when another worktree has the branch. Runs `team.toml` `setup` in a new worktree. Prints its status and worktree. |
| `devteam prompt <name> <text>` | Submits a prompt without waiting. |
| `devteam key <name> <key>...` | Presses `up`, `down`, `enter` or `esc`, for dialogs and interrupts. |
| `devteam read <name> [--lines N]` | Prints recent terminal output. |
| `devteam list` | Prints each agent's role, task, status and worktree. |
| `devteam fire <name> [--force] [--keep-worktree]` | Sends the role's `exit` command, closes its terminal, removes its worktree unless kept. |
| `devteam clean <id> [--force]` | Removes the kept worktree on `devteam/<id>` and deletes the branch once merged. |

### Heartbeat

The director wakes only on events: a worker report or a hearth message. If every worker stalls, for example after the Mac sleeps, no event arrives. The heartbeat closes that gap. Every `heartbeat_minutes`, if the director is idle and has workers, it prompts the director with `heartbeat`. The director then reads every worker's screen and treats one whose screen has not changed since the last check as stalled.

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
  Retested 2026-10-26 for claude in Orca 1.4.240 with `orca terminal send`. The running command was not interrupted. Claude took the queued message into the same turn and answered it. Codex was not retested in Orca.

- **R3.** `devteam up` starts the hearth runner with the devteam engine on both backends (t068). The engine reaches the director only through `devteam prompt` and `devteam list`. Criterion 8's wake step under Orca is tested only against a fake `orca` until a live run confirms it.

- **R4.** Orca terminal handles change when Orca restarts. After a restart, `devteam` cannot reach the team's agents. Run `devteam down` and `devteam up` again.

- **R1.** With no approval gates, a director-written role could weaken a check, such as a reviewer that passes too easily. Mitigation is visibility: every project role is a file in git and every role change is logged in `log.md`.

## Acceptance criteria

1. `devteam up --new /tmp/x` creates a git repo with `.devteam/` and a live director in herdr or Orca, and the director asks the human for the vision.
2. `devteam up <existing repo>` changes no files outside `.devteam/`, and the director writes `context.md`.
3. Given a goal with two independent tasks, the director hires two builders in separate worktrees, and both run at once.
4. With `max_agents = 1`, the second task stays `queued` until the first is done.
5. A task merges only after every review in its `reviews` list and its test record a pass, or the skipped stage has a logged reason.
6. The director can write a project role, use it to hire a worker, and log why.
7. `devteam down` leaves no agents, worktrees, or herdr workspace behind, and keeps `.devteam/tasks/`.
8. A decision outside `vision.md` adds an entry to `questions.md`, sets only the affected tasks to `waiting`, and DMs the human on hearth, or asks in the director's terminal without hearth. Unaffected tasks keep moving. A reply in the DM wakes an idle director, and the answer is appended to `vision.md`.
9. A worker finishing a task wakes an idle director without human input.
10. With an idle director and a stalled worker, the heartbeat wakes the director within `heartbeat_minutes`, and the director resends or replaces the worker.
11. Missing the chosen backend (`herdr` or `orca`), `git`, a cataloged agent CLI, or, when any `HEARTH_` variable is set, any other `HEARTH_` variable makes `devteam up` exit non-zero, naming the missing tool.
12. After `up`, no file in `.devteam/` references the blueprint path, and the kickoff names only project files and the devteam CLI.
13. A task is announced only after main passes the definition of done.
14. Criteria 1 to 7 and 9 to 13 pass on both backends. On Orca, criterion 8's wake step is not yet confirmed live (R3).
15. With no `HEARTH_` variables set, `devteam up` starts the director without hearth, and the director asks for the vision in its terminal.
