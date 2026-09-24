"""Exercise the checked-in publication steps against disposable local Git remotes."""

from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
STEPS = {
    "keepalive.yml": "Touch .keepalive and commit [skip ci]",
    "org-hygiene-report.yml": "Commit report + bookends [skip ci]",
}
GIT = shutil.which("git")
BASH = shutil.which("bash")


def publication_script(filename: str) -> str:
    """Extract the actual named literal run block; fail if its shape changes."""
    text = (WORKFLOWS / filename).read_text(encoding="utf-8")
    match = re.search(
        r"^      - name: " + re.escape(STEPS[filename]) + r"\n"
        r"(?:(?!      - name:)[\s\S])*?^        run: \|\n"
        r"((?:^          .*\n|^\n)+)",
        text,
        re.MULTILINE,
    )
    if not match:
        raise AssertionError(f"Cannot find literal publication step in {filename}")
    return textwrap.dedent(match.group(1))


class PersistenceBoundaryTests(unittest.TestCase):
    def setUp(self):
        if not GIT or not BASH:
            self.fail("git and bash are required; these boundary tests must not skip")
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.work = self.root / "work"
        self.peer = self.root / "peer"
        self.remote = self.root / "remote.git"
        self.log = self.root / "git-commands.log"
        home = self.root / "home"
        home.mkdir()
        self.env = {
            "PATH": os.defpath,
            "HOME": str(home),
            "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ALLOW_PROTOCOL": "file",
        }
        self.git(self.root, "init", "--bare", "--initial-branch=main", str(self.remote))
        self.work.mkdir()
        self.git(self.work, "init", "--initial-branch=main")
        self.configure(self.work)
        (self.work / ".keepalive").write_text("initial\n", encoding="utf-8")
        (self.work / "sentinel.txt").write_text("preserve me\n", encoding="utf-8")
        (self.work / "bookends").mkdir()
        (self.work / "bookends" / "fixture.tsv").write_text("initial\n", encoding="utf-8")
        self.git(self.work, "add", ".")
        self.git(self.work, "commit", "-m", "fixture base")
        self.git(self.work, "remote", "add", "origin", str(self.remote))
        self.git(self.work, "push", "-u", "origin", "main")
        self.git(self.root, "clone", str(self.remote), str(self.peer))
        self.configure(self.peer)
        wrappers = self.root / "bin"
        wrappers.mkdir()
        wrapper = wrappers / "git"
        wrapper.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GIT_COMMAND_LOG"\n'
            f'exec "{GIT}" "$@"\n',
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
        self.execution_env = dict(
            self.env,
            PATH=str(wrappers) + os.pathsep + os.defpath,
            GIT_COMMAND_LOG=str(self.log),
        )

    def git(self, cwd: Path, *args: str) -> str:
        result = subprocess.run(
            [GIT, *args], cwd=cwd, env=self.env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def configure(self, cwd: Path):
        self.git(cwd, "config", "user.name", "Boundary Fixture")
        self.git(cwd, "config", "user.email", "fixture@example.invalid")
        self.git(cwd, "config", "commit.gpgsign", "false")

    def peer_change(self, path: str, content: str):
        target = self.peer / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self.git(self.peer, "add", "--", path)
        self.git(self.peer, "commit", "-m", "concurrent fixture")
        self.git(self.peer, "push", "origin", "main")

    def prepare_report(self, with_report: bool = True):
        (self.work / "bookends" / "fixture.tsv").write_text("initial\nlocal\n", encoding="utf-8")
        if with_report:
            (self.work / "reports").mkdir()
            (self.work / "reports" / "fixture.md").write_text("local report\n", encoding="utf-8")

    def run_publication(self, filename: str):
        return subprocess.run(
            [BASH, "-c", publication_script(filename)], cwd=self.work,
            env=self.execution_env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
        )

    def assert_no_push(self):
        commands = self.log.read_text(encoding="utf-8").splitlines()
        self.assertFalse(any(command == "push" or command.startswith("push ") for command in commands), commands)

    def test_same_repository_history_has_one_non_cancelling_group(self):
        groups = []
        for filename in STEPS:
            text = (WORKFLOWS / filename).read_text(encoding="utf-8")
            match = re.search(r"^concurrency:\n  group: ([^\n]+)\n  cancel-in-progress: false$", text, re.MULTILINE)
            self.assertIsNotNone(match)
            groups.append(match.group(1))
        self.assertEqual(groups, ["ops-default-history", "ops-default-history"])

    def test_no_autostash_or_ignored_publication_failure(self):
        for filename in STEPS:
            with self.subTest(workflow=filename):
                script = publication_script(filename)
                self.assertNotIn("--autostash", script)
                self.assertNotIn("|| true", script)
                self.assertIn("git pull --rebase origin", script)
                self.assertNotIn("--force", script)

    def test_keepalive_preserves_disjoint_concurrent_commit(self):
        self.peer_change("peer.txt", "peer\n")
        result = self.run_publication("keepalive.yml")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.remote, "show", "main:peer.txt"), "peer")
        self.assertTrue(self.git(self.remote, "show", "main:.keepalive").startswith("initial\nlast-keepalive:"))
        self.assertEqual(self.git(self.remote, "show", "main:sentinel.txt"), "preserve me")

    def test_hygiene_preserves_disjoint_concurrent_commit(self):
        self.peer_change("peer.txt", "peer\n")
        self.prepare_report()
        result = self.run_publication("org-hygiene-report.yml")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.remote, "show", "main:peer.txt"), "peer")
        self.assertEqual(self.git(self.remote, "show", "main:reports/fixture.md"), "local report")
        self.assertEqual(self.git(self.remote, "show", "main:bookends/fixture.tsv"), "initial\nlocal")

    def test_keepalive_conflict_stops_before_push(self):
        self.peer_change(".keepalive", "initial\npeer\n")
        remote_before = self.git(self.remote, "rev-parse", "main")
        result = self.run_publication("keepalive.yml")
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_push()
        self.assertEqual(self.git(self.remote, "rev-parse", "main"), remote_before)
        self.assertIn("last-keepalive:", self.git(self.work, "show", "ORIG_HEAD:.keepalive"))

    def test_hygiene_conflict_stops_before_push(self):
        self.peer_change("bookends/fixture.tsv", "initial\npeer\n")
        remote_before = self.git(self.remote, "rev-parse", "main")
        self.prepare_report()
        result = self.run_publication("org-hygiene-report.yml")
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_push()
        self.assertEqual(self.git(self.remote, "rev-parse", "main"), remote_before)
        self.assertEqual(self.git(self.work, "show", "ORIG_HEAD:bookends/fixture.tsv"), "initial\nlocal")

    def test_report_failure_still_persists_bookends_without_reports_directory(self):
        self.prepare_report(with_report=False)
        result = self.run_publication("org-hygiene-report.yml")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.remote, "show", "main:bookends/fixture.tsv"), "initial\nlocal")

    def test_dirty_checkout_is_not_stashed_or_published(self):
        self.prepare_report()
        (self.work / "sentinel.txt").write_text("other writer's uncommitted data\n", encoding="utf-8")
        remote_before = self.git(self.remote, "rev-parse", "main")
        result = self.run_publication("org-hygiene-report.yml")
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_push()
        self.assertEqual(self.git(self.remote, "rev-parse", "main"), remote_before)
        self.assertEqual((self.work / "sentinel.txt").read_text(), "other writer's uncommitted data\n")
        self.assertEqual(self.git(self.work, "stash", "list"), "")

    def test_fetch_failure_is_not_followed_by_push(self):
        self.prepare_report()
        self.git(self.work, "remote", "set-url", "origin", str(self.root / "absent.git"))
        result = self.run_publication("org-hygiene-report.yml")
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_push()


if __name__ == "__main__":
    unittest.main()
