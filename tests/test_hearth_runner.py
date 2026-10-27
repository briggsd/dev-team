"""devteam up and down with hearth on, against fake herdr, orca and agent CLIs that record their arguments.

Run: python3 -m unittest discover -s tests
"""

import json
import os
import shlex
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

DEVTEAM = Path(__file__).resolve().parent.parent / "bin/devteam"
BLUEPRINT = DEVTEAM.parent.parent
TOKEN = "hagt_t068secrettoken"

# Each fake appends its argv to $FAKE_LOG as a JSON line and prints a canned reply. FAKE_FAIL names a
# "<tool> <arg1> <arg2>" call that fails instead.
FAKE = r'''#!/usr/bin/env python3
import json, os, sys
tool, args = os.path.basename(sys.argv[0]), sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps([tool, *args]) + "\n")
key = " ".join([tool, *args[:2]])
if os.environ.get("FAKE_FAIL") == key:
    print(json.dumps({"ok": False, "error": {"code": "boom", "message": "fake failure"}}))
    sys.exit(1)
n = sum(1 for _ in open(os.environ["FAKE_LOG"]))
replies = {
    "herdr workspace create": {"workspace": {"workspace_id": "w1"}, "root_pane": {"pane_id": "p-director"}},
    "herdr pane split": {"pane": {"pane_id": f"p{n}"}},
    "herdr agent get": {"agent": {"agent_status": "idle"}},
    "herdr worktree list": {"worktrees": []},
    "orca terminal create": {"terminal": {"handle": f"t{n}"}},
    "orca terminal wait": {"wait": {"status": "running", "satisfied": True}},
    "orca terminal send": {"turn_started": True},
}
print(json.dumps({"ok": True, "result": replies.get(key, {})}))
'''


class HearthRunner(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="devteam-test-"))
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        for tool in ("herdr", "orca", "claude", "codex"):
            f = bin_dir / tool
            f.write_text(FAKE)
            f.chmod(0o755)
        self.hearth = self.tmp / "hearth"
        for f in ("runner/index.ts", "mcp/index.ts"):
            (self.hearth / f).parent.mkdir(parents=True, exist_ok=True)
            (self.hearth / f).write_text("")
        self.repo = self.tmp / "proj"
        self.repo.mkdir()
        for c in (["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "init"]):
            subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *c], cwd=self.repo, check=True)
        # mkdtemp in devteam puts the token directory here, so the test can find it and see it removed.
        self.tokens = self.tmp / "tokens"
        self.tokens.mkdir()
        self.log = self.tmp / "calls.jsonl"
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("HEARTH_", "ORCA_", "HERDR_", "RUNNER_", "DEVTEAM_"))}
        self.env.update(PATH=f"{bin_dir}:{os.environ['PATH']}", FAKE_LOG=str(self.log), TMPDIR=str(self.tokens),
                        HEARTH_DIR=str(self.hearth), HEARTH_URL="http://hearth.test", HEARTH_TOKEN=TOKEN,
                        HEARTH_HUMAN="owner")

    def tearDown(self):
        subprocess.run(["rm", "-rf", str(self.tmp)])

    def devteam(self, *args, **env):
        return subprocess.run([str(DEVTEAM), *args], cwd=self.repo, env={**self.env, **env}, capture_output=True,
                              text=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def session(self):
        return json.loads((self.repo / ".devteam/session.json").read_text())

    def runner_env(self, command):
        """The env assignments of a runner command, after checking it runs hearth's runner/index.ts under node."""
        words = shlex.split(command)
        self.assertEqual(words[0], "env")
        self.assertEqual(words[-2:], ["node", str(self.hearth / "runner/index.ts")])
        return dict(w.split("=", 1) for w in words[1:-2])

    def check_env(self, env, alerts=None):
        self.assertEqual(env["RUNNER_EXTENSIONS"], str(BLUEPRINT / "hearth/devteam-engine.ts"))
        self.assertEqual(env["RUNNER_ENGINE"], "devteam")
        self.assertEqual(env["RUNNER_TRIGGER"], "owner")
        self.assertEqual(env["DEVTEAM_AGENT"], "proj-director")
        self.assertEqual(env["DEVTEAM_PROJECT"], str(self.repo.resolve()))
        self.assertEqual(env["HEARTH_URL"], "http://hearth.test")
        self.assertEqual(env["PATH"].split(":")[0], str(BLUEPRINT / "bin"))
        self.assertEqual(env.get("RUNNER_ALERTS"), alerts)
        self.assertNotIn("HEARTH_TOKEN", env)
        f = Path(env["HEARTH_TOKEN_FILE"])
        self.assertEqual(f.read_text().strip(), TOKEN)
        self.assertEqual(stat.S_IMODE(f.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(f.parent.stat().st_mode), 0o700)
        return f

    def check_no_token(self, out):
        self.assertNotIn(TOKEN, json.dumps(self.calls()))
        self.assertNotIn(TOKEN, (self.repo / ".devteam/session.json").read_text())
        self.assertNotIn(TOKEN, out)

    def test_orca_starts_and_closes_the_runner(self):
        up = self.devteam("up", "--backend", "orca", HEARTH_ALERTS="ch_alerts")
        self.assertEqual(up.returncode, 0, up.stderr)
        creates = [c for c in self.calls() if c[1:3] == ["terminal", "create"]]
        runner = [c for c in creates if c[c.index("--title") + 1] == "proj-hearth-runner"]
        self.assertEqual(len(runner), 1)
        token_file = self.check_env(self.runner_env(runner[0][runner[0].index("--command") + 1]), alerts="ch_alerts")
        handle = self.session()["runner"]
        self.assertTrue(handle.startswith("t"))
        self.assertIn(f"hearth runner proj-hearth-runner in orca {handle}, alerts from channel ch_alerts", up.stdout)
        # The director's hearth MCP server reads the same file.
        director = next(c for c in creates if c[c.index("--title") + 1] == "proj-director")
        self.assertIn(f'"HEARTH_TOKEN_FILE": "{token_file}"', director[director.index("--command") + 1])
        self.check_no_token(up.stdout + up.stderr)

        down = self.devteam("down")
        self.assertEqual(down.returncode, 0, down.stderr)
        self.assertIn(["orca", "terminal", "close", "--terminal", handle, "--json"], self.calls())
        self.assertFalse(token_file.parent.exists())

    def test_herdr_starts_and_closes_the_runner(self):
        up = self.devteam("up", "--backend", "herdr")
        self.assertEqual(up.returncode, 0, up.stderr)
        calls = self.calls()
        pane = self.session()["runner"]
        split = next(i for i, c in enumerate(calls) if c[1:3] == ["pane", "split"])
        self.assertEqual(calls[split][calls[split].index("--pane") + 1], "p-director")
        self.assertEqual(calls[split + 1][:4], ["herdr", "pane", "run", pane])
        token_file = self.check_env(self.runner_env(calls[split + 1][4]))
        # The heartbeat goes below the runner.
        beat = [c for c in calls if c[1:3] == ["pane", "split"]][1]
        self.assertEqual(beat[beat.index("--pane") + 1], pane)
        self.assertIn(f"hearth runner proj-hearth-runner in herdr {pane}, no alerts", up.stdout)
        self.check_no_token(up.stdout + up.stderr)

        down = self.devteam("down")
        self.assertEqual(down.returncode, 0, down.stderr)
        # The runner pane is in the team's workspace, which down closes.
        self.assertIn(["herdr", "workspace", "close", "w1"], self.calls())
        self.assertFalse(token_file.parent.exists())

    def test_failed_up_removes_the_token(self):
        up = self.devteam("up", "--backend", "herdr", FAKE_FAIL="herdr workspace create")
        self.assertNotEqual(up.returncode, 0)
        self.assertIn("fake failure", up.stderr)
        self.assertEqual(list(self.tokens.iterdir()), [])

    def test_both_backends_need_the_runner(self):
        (self.hearth / "runner/index.ts").unlink()
        for backend in ("herdr", "orca"):
            up = self.devteam("up", "--backend", backend)
            self.assertNotEqual(up.returncode, 0)
            self.assertIn(f"{self.hearth}/runner/index.ts (set HEARTH_DIR)", up.stderr)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
