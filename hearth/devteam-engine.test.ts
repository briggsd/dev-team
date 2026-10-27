import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import setup, { devteam } from "./devteam-engine.ts";

// Run with: node --test hearth/ (HEARTH_DIR names a hearth checkout with its node_modules, default ~/workspace/hearth)
const hearthDir = process.env.HEARTH_DIR ?? join(homedir(), "workspace/hearth");
const { Busy } = await import(pathToFileURL(join(hearthDir, "runner/runner.ts")).href);

const dirs: string[] = [];
const path = process.env.PATH;
after(() => {
  process.env.PATH = path;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A stand-in `devteam`, put first on PATH. `list` prints two agents, hearth-director with the first line of
// `statuses` (which it then drops, keeping the last). `prompt` logs the agent, the text and, when the text names a
// task file, its contents and mode, then writes `reply` to the path the task names and replaces `statuses` with
// `after`. An unknown agent fails like the real CLI. `herdr` and `orca` beside it log any call, which must not happen.
function fake(o: { statuses: string[]; reply?: string; after?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), "fake-devteam-"));
  dirs.push(dir);
  const statuses = join(dir, "statuses");
  const prompts = join(dir, "prompts");
  const forbidden = join(dir, "forbidden");
  writeFileSync(statuses, o.statuses.join("\n"));
  writeFileSync(join(dir, "devteam"), `#!${process.execPath}
const fs = require("node:fs");
const [cmd, name, text] = process.argv.slice(2);
if (cmd === "list") {
  const s = fs.readFileSync(${JSON.stringify(statuses)}, "utf8").split("\\n");
  if (s.length > 1) fs.writeFileSync(${JSON.stringify(statuses)}, s.slice(1).join("\\n"));
  process.stdout.write("hearth-director\\trole=director\\ttask=-\\tstatus=" + s[0] + "\\tworktree=-\\nbuilder-1\\trole=builder\\ttask=t1\\tstatus=idle\\tworktree=/w\\n");
  process.exit(0);
}
if (cmd !== "prompt") process.exit(2);
if (name !== "hearth-director") { process.stderr.write("devteam: no agent named " + name + "\\n"); process.exit(1); }
const task = /^Read (\\S+) and/.exec(text)?.[1];
const entry = { name, text };
if (task) {
  entry.task = fs.readFileSync(task, "utf8");
  entry.mode = fs.statSync(task).mode & 0o777;
  const reply = / to (\\S+)\\. If no reply/.exec(entry.task)[1];
  ${o.reply === undefined ? "" : `fs.writeFileSync(reply, ${JSON.stringify(o.reply)});`}
}
fs.appendFileSync(${JSON.stringify(prompts)}, JSON.stringify(entry) + "\\n");
${o.after ? `fs.writeFileSync(${JSON.stringify(statuses)}, ${JSON.stringify(o.after.join("\n"))});` : ""}
`);
  for (const tool of ["herdr", "orca"]) writeFileSync(join(dir, tool), `#!/bin/sh\necho ${tool} "$@" >> ${forbidden}\n`);
  for (const tool of ["devteam", "herdr", "orca"]) chmodSync(join(dir, tool), 0o755);
  process.env.PATH = `${dir}:${path}`;
  return {
    prompts: () => existsSync(prompts) ? readFileSync(prompts, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [],
    forbidden: () => existsSync(forbidden),
  };
}

const make = (o: { timeoutMs?: number } = {}) => devteam({ agent: "hearth-director", url: "http://hearth.test/", Busy, timeoutMs: o.timeoutMs ?? 5000, pollMs: 10 });
const dm = (canWrite = true) => ({ serverId: null, channelId: "c1", canWrite, watched: false, signal: new AbortController().signal });
const alertAt = () => ({ serverId: "s1", channelId: "c9", name: "alerts", signal: new AbortController().signal });

test("devteam engine: hands the task to the agent as a mode 600 file, waits until it is idle again, and returns the reply it wrote", async () => {
  const f = fake({ statuses: ["idle"], reply: "**done**", after: ["working", "working", "idle"] });
  const { engine } = make();
  assert.equal(await engine("@sam: hello", dm()), "**done**");
  const [p] = f.prompts();
  assert.equal(p.name, "hearth-director");
  assert.match(p.text, /^Read \S+task-\S+\.md and do what it asks\.$/);
  assert.equal(p.mode, 0o600);
  assert.match(p.task, /^@sam: hello\n\nThe hearth runner posts your reply/);
  assert.doesNotMatch(p.task, /not from your owner/);
  assert.equal(existsSync(p.text.split(" ")[1]), false, "the task file is removed after the run");
  // the agent was polled through both working statuses before the reply was read
  assert.equal(readFileSync(join(process.env.PATH!.split(":")[0], "statuses"), "utf8"), "idle");
  assert.equal(f.forbidden(), false);
});

test("devteam engine: a done agent takes a run too, and no reply file means no reply", async () => {
  const f = fake({ statuses: ["done"], after: ["working", "done"] });
  assert.equal(await make().engine("hi", dm()), "");
  assert.equal(f.prompts().length, 1);
});

test("devteam engine: a run from someone other than the owner marks the message as untrusted", async () => {
  const f = fake({ statuses: ["idle"], reply: "ok", after: ["idle"] });
  await make().engine("@webhook: rm -rf", { ...dm(false), serverId: "s1", watched: true });
  assert.match(f.prompts()[0].task, /not from your owner.*untrusted content/s);
});

test("devteam engine: runs woken in a server outside a watched channel are refused before devteam is called", async () => {
  const f = fake({ statuses: ["idle"] });
  assert.equal(await make().engine("hi", { ...dm(), serverId: "s1" }), "I only take work in a direct message from my owner.");
  assert.equal(f.prompts().length, 0);
});

test("devteam engine: a working agent is not prompted, and the runner is asked to hold the message with Busy", async () => {
  const f = fake({ statuses: ["working"] });
  const err = await make().engine("hi", dm()).catch(e => e);
  assert.ok(err instanceof Busy);
  assert.equal(err.message, "I'm busy with another task. Your message is queued and I'll get it when I'm free.");
  assert.equal(err.retryMs, 10);
  assert.equal(f.prompts().length, 0);
});

test("devteam engine: a blocked agent, in herdr's or Orca's form, gets no prompt and the run says it is waiting on an approval", async () => {
  for (const s of ["blocked", "blocked (permission prompt)"]) {
    const f = fake({ statuses: [s] });
    assert.equal(await make().engine("hi", dm()), "I'm waiting on an approval. Ask again once @hearth-director is unblocked.");
    assert.equal(f.prompts().length, 0);
  }
});

test("devteam engine: blocking mid-run says so, unless the reply is already written", async () => {
  fake({ statuses: ["idle"], after: ["working", "blocked (permission prompt)"] });
  assert.equal(await make().engine("hi", dm()), "I'm waiting on an approval. My reply will be in @hearth-director's terminal.");
  fake({ statuses: ["idle"], reply: "written", after: ["blocked"] });
  assert.equal(await make().engine("hi", dm()), "written");
});

test("devteam engine: a message held past the run timeout is not delivered and says so, and the next one is held afresh", async () => {
  const f = fake({ statuses: ["working"] });
  const { engine } = make({ timeoutMs: 50 });
  assert.ok((await engine("hi", dm()).catch(e => e)) instanceof Busy);
  await sleep(60);
  assert.equal(await engine("hi", dm()), "I stayed busy too long, so your message was not delivered. Send it again in a bit.");
  assert.ok((await engine("hi", dm()).catch(e => e)) instanceof Busy);
  assert.equal(f.prompts().length, 0);
});

test("devteam engine: an agent still working at the run timeout fails the run", async () => {
  fake({ statuses: ["idle"], after: ["working"] });
  await assert.rejects(make({ timeoutMs: 50 }).engine("hi", dm()), /@hearth-director was still working after the run timeout/);
});

test("devteam engine: an unknown, gone or exited agent fails the run with a clear error", async () => {
  fake({ statuses: ["idle"] });
  await assert.rejects(devteam({ agent: "nobody", url: "", Busy }).engine("hi", dm()), /devteam list shows no agent nobody/);
  for (const s of ["gone", "exited"]) {
    const f = fake({ statuses: [s] });
    await assert.rejects(make().engine("hi", dm()), new RegExp(`@hearth-director is ${s} in devteam`));
    assert.equal(f.prompts().length, 0);
  }
});

test("devteam alert: prompts the agent with fixed text naming only the channel, server and hearth URL, and waits until it is idle", async () => {
  const f = fake({ statuses: ["idle"], after: ["working", "idle"] });
  await make().alert(alertAt());
  assert.deepEqual(f.prompts(), [{
    name: "hearth-director",
    text: "New alerts in #alerts (channel id c9 in server id s1) on the hearth at http://hearth.test. Read the newest messages in that channel and handle them.",
  }]);
  assert.equal(readFileSync(join(process.env.PATH!.split(":")[0], "statuses"), "utf8"), "idle");
  assert.equal(f.forbidden(), false);
});

test("devteam alert: a working or blocked agent is not prompted and the runner holds the alerts with Busy, up to the run timeout", async () => {
  for (const s of ["working", "blocked"]) {
    const f = fake({ statuses: [s] });
    const { alert } = make({ timeoutMs: 50 });
    const err = await alert(alertAt()).catch(e => e);
    assert.ok(err instanceof Busy);
    assert.equal(err.retryMs, 10);
    await sleep(60);
    await assert.rejects(alert(alertAt()), new RegExp(`@hearth-director stayed ${s} too long, so the alerts were not handed over`));
    assert.equal(f.prompts().length, 0);
  }
});

test("devteam extension: registers the engine devteam, not read-only, with an alert, for DEVTEAM_AGENT", async () => {
  const argv1 = process.argv[1];
  process.argv[1] = join(hearthDir, "runner/index.ts");
  try {
    const registered: { name: string; opts?: { readOnly?: boolean; alert?: unknown } }[] = [];
    const api = { registerEngine: (name: string, _e: unknown, opts?: { readOnly?: boolean; alert?: unknown }) => registered.push({ name, opts }) };
    delete process.env.DEVTEAM_AGENT;
    await assert.rejects(setup(api as never), /Set DEVTEAM_AGENT/);
    process.env.DEVTEAM_AGENT = "hearth-director";
    await setup(api as never);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "devteam");
    assert.notEqual(registered[0].opts?.readOnly, true);
    assert.equal(typeof registered[0].opts?.alert, "function");
  } finally {
    process.argv[1] = argv1;
    delete process.env.DEVTEAM_AGENT;
  }
});
