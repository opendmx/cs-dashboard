import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

const script = fileURLToPath(new URL("../.devcontainer/backup.sh", import.meta.url));

test("devcontainer starts the backup service on every container start", () => {
  const config = JSON.parse(readFileSync(new URL("../.devcontainer/devcontainer.json", import.meta.url), "utf8"));
  assert.equal(config.postStartCommand, "bash .devcontainer/backup.sh start");
  assert.match(config.image, /^mcr\.microsoft\.com\/devcontainers\/javascript-node:/);
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "codespace-backup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "work");
  const remote = path.join(root, "remote.git");
  function command(program, args, cwd = repo) {
    const result = spawnSync(program, args, {
      cwd, encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  }
  command("git", ["init", "--bare", remote], root);
  command("git", ["init", repo], root);
  const git = (...args) => command("git", args);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(path.join(repo, "tracked.txt"), "original\n");
  writeFileSync(path.join(repo, "delete.txt"), "delete me\n");
  writeFileSync(path.join(repo, ".gitignore"), "secret.txt\n");
  git("add", ".");
  git("commit", "-m", "Initial");
  git("remote", "add", "origin", remote);
  return {
    repo, remote, git,
    write: (name, content) => writeFileSync(path.join(repo, name), content),
    backup: () => command("bash", [script, "once"]),
    refs: () => git("--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads/codespace-backup/").split("\n").filter(Boolean),
    pending: () => git("for-each-ref", "--format=%(refname)", "refs/codespace-backup/pending/")
  };
}

test("snapshots saved files without changing HEAD, working files, or the real index", (t) => {
  const f = fixture(t);
  f.write("tracked.txt", "staged\n");
  f.git("add", "tracked.txt");
  f.write("tracked.txt", "unstaged\n");
  f.write("new file.txt", "new\n");
  f.write("secret.txt", "not published\n");
  rmSync(path.join(f.repo, "delete.txt"));
  const head = f.git("rev-parse", "HEAD");
  const branch = f.git("symbolic-ref", "HEAD");
  const index = readFileSync(path.join(f.repo, ".git/index"));
  f.backup();
  const [ref] = f.refs();
  assert.ok(ref);
  assert.equal(f.git("--git-dir", f.remote, "show", `${ref}:tracked.txt`), "unstaged");
  assert.equal(f.git("--git-dir", f.remote, "show", `${ref}:new file.txt`), "new");
  const files = f.git("--git-dir", f.remote, "ls-tree", "--name-only", ref);
  assert.doesNotMatch(files, /secret\.txt|delete\.txt/);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("symbolic-ref", "HEAD"), branch);
  assert.deepEqual(readFileSync(path.join(f.repo, ".git/index")), index);
  assert.equal(readFileSync(path.join(f.repo, "tracked.txt"), "utf8"), "unstaged\n");
  assert.equal(f.pending(), "");
  f.backup();
  assert.equal(f.refs().length, 1);
  f.write("tracked.txt", "next snapshot\n");
  f.backup();
  assert.equal(f.refs().length, 2);
});

test("clean working trees and new source commits are backed up without duplicates", (t) => {
  const f = fixture(t);
  f.backup();
  f.backup();
  assert.equal(f.refs().length, 1);
  f.git("commit", "--allow-empty", "-m", "Unpushed work");
  const head = f.git("rev-parse", "HEAD");
  f.backup();
  assert.equal(f.refs().length, 2);
  assert.ok(f.refs().some((ref) => f.git("--git-dir", f.remote, "rev-parse", `${ref}^`) === head));
});

test("failed pushes remain queued and recover on a subsequent invocation", (t) => {
  const f = fixture(t);
  f.git("remote", "set-url", "origin", path.join(f.repo, "missing.git"));
  const result = spawnSync("bash", [script, "once"], { cwd: f.repo, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR: Push failed/);
  assert.ok(f.pending());
  f.write("tracked.txt", "new work while offline\n");
  f.git("remote", "set-url", "origin", f.remote);
  f.backup();
  assert.equal(f.refs().length, 2);
  assert.equal(f.pending(), "");
});

test("snapshot errors are reported without publishing a partial snapshot", (t) => {
  const f = fixture(t);
  // A nested repository without a commit cannot be added to a Git snapshot.
  spawnSync("git", ["init", path.join(f.repo, "nested")]);
  const result = spawnSync("bash", [script, "once"], { cwd: f.repo, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR: Snapshot failed/);
  assert.equal(f.pending(), "");
  assert.equal(f.refs().length, 0);
});

test("service runs a second backup after 60 seconds and prevents duplicate workers", { timeout: 75000 }, async (t) => {
  const f = fixture(t);
  const child = spawn("bash", [script, "run"], { cwd: f.repo, stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  async function waitForRefs(count, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (f.refs().length === count) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail(`Expected ${count} backup branches`);
  }
  await waitForRefs(1, 5000);
  const started = Date.now();
  f.write("tracked.txt", "periodic snapshot\n");
  const duplicate = spawnSync("bash", [script, "run"], { cwd: f.repo, encoding: "utf8", timeout: 2000 });
  assert.equal(duplicate.status, 0);
  assert.match(duplicate.stdout, /already running/);
  await waitForRefs(2, 65000);
  assert.ok(Date.now() - started >= 55000, "Periodic backup must use the 60-second interval");
  f.write("tracked.txt", "final snapshot\n");
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  assert.equal(f.refs().length, 3);
});
