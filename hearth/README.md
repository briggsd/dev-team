# Hearth runner engine for a devteam

`devteam-engine.ts` is a hearth runner extension (hearth `docs/runner.md`, Extensions). It registers the engine `devteam`, which hands each hearth run and each alert to one devteam agent, usually the director. It reaches that agent only through `devteam prompt` and `devteam list`, so it works the same when the team runs under herdr or Orca.

## Start the runner

Run it from the project the team belongs to, with `devteam` on PATH and the director's hearth agent token in a mode 600 file:

```sh
PATH=<dev-team>/bin:$PATH \
HEARTH_URL=<hearth url> HEARTH_TOKEN_FILE=<token file> \
RUNNER_EXTENSIONS=<dev-team>/hearth/devteam-engine.ts RUNNER_ENGINE=devteam \
RUNNER_ALERTS=<alerts channel id> DEVTEAM_AGENT=<director> \
node <hearth>/runner/index.ts
```

For example `DEVTEAM_AGENT=hearth-director`. Leave out `RUNNER_ALERTS` if the director takes no alerts. To start it from another directory, set `DEVTEAM_PROJECT` to the project path. The `devteam` calls run there.

## What it does

- **A run** (a DM from the owner, or a message in a watched channel): writes the conversation to a mode 600 task file, prompts the agent `Read <task> and do what it asks.`, polls `devteam list` until the agent's turn has started (a working or blocked status, or the reply file) and it is idle or done again, and posts the reply file the task named. No reply file means no reply. If no start is seen within 60 seconds, the run replies that the message was not delivered and keeps the task file, since the prompt may still run. A message in a server channel that is not watched is refused.
- **Busy**: while the agent is working, the runner holds the message and asks again every 5 seconds. After 10 minutes it replies that the message was not delivered.
- **Blocked**: an agent waiting on an approval gets no prompt, and the run says so. If it blocks mid-run without a reply, the run says the reply will be in its terminal.
- **An alert** (a webhook in the `RUNNER_ALERTS` channel): prompts the agent with fixed text naming only the channel, server and hearth URL, so no webhook text reaches it. It waits for an idle agent the same way, for up to 10 minutes.
- An agent that is gone, has exited or is not in `devteam list` fails the run with an error in the runner's log.

## Test

```sh
HEARTH_DIR=<hearth checkout with node_modules> node --test hearth/*.test.ts
```

`HEARTH_DIR` defaults to `~/workspace/hearth`. The test runs the extension against a fake `devteam` on PATH.
