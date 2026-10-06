import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { recoverProfileLocks } from "../src/profile-locks.js";

function fixture(host = "old-container-84") {
  const profile = path.resolve("test-profile"), files = new Map([
    ["SingletonLock", { link: true, target: host }],
    ["SingletonSocket", { link: true, target: "/tmp/chrome/SingletonSocket" }],
    ["SingletonCookie", { link: true, target: "token" }],
    ["Cookies", { link: false, target: "private session" }],
    ["Preferences", { link: false, target: "private settings" }],
  ]);
  const deleted: string[] = [];
  const read = (file: string) => { assert.equal(path.dirname(file), profile); const entry = files.get(path.basename(file)); if (!entry) throw Object.assign(new Error("absent"), { code: "ENOENT" }); return entry; };
  const io = {
    async readlink(file: string) { const entry = read(file); if (!entry.link) throw Object.assign(new Error("not a link"), { code: "EINVAL" }); return entry.target; },
    async lstat(file: string) { const entry = read(file); return { isSymbolicLink: () => entry.link }; },
    async unlink(file: string) { read(file); deleted.push(file); files.delete(path.basename(file)); },
  };
  return { profile, files, deleted, io };
}

test("old container locks are removed without following socket targets or touching sessions", async () => {
  const f = fixture();
  assert.deepEqual(await recoverProfileLocks(f.profile, { hostname: "new-container", pidAlive: () => true }, f.io), ["SingletonLock", "SingletonSocket", "SingletonCookie"]);
  assert.deepEqual([...f.files.keys()], ["Cookies", "Preferences"]);
  assert.equal(f.files.get("Cookies")!.target, "private session");
  assert.equal(f.deleted.length, 3);
});

test("a live local browser preserves every lock", async () => {
  const f = fixture("same-container-84");
  await assert.rejects(recoverProfileLocks(f.profile, { hostname: "same-container", pidAlive: pid => pid === 84 }, f.io), /действующим процессом/);
  assert.equal(f.deleted.length, 0);
});

test("dead local locks recover and a second recovery is a no-op", async () => {
  const f = fixture("same-container-84"), owner = { hostname: "same-container", pidAlive: () => false };
  assert.equal((await recoverProfileLocks(f.profile, owner, f.io)).length, 3);
  assert.deepEqual(await recoverProfileLocks(f.profile, owner, f.io), []);
});

test("malformed locks and regular files cause recovery to stop before deleting anything", async () => {
  for (const value of ["malformed", "old-container-0", "old-container-999999999999999999999"]) {
    const f = fixture(value);
    await assert.rejects(recoverProfileLocks(f.profile, { hostname: "new", pidAlive: () => false }, f.io));
    assert.equal(f.deleted.length, 0);
  }
  const f = fixture(); f.files.get("SingletonCookie")!.link = false;
  await assert.rejects(recoverProfileLocks(f.profile, { hostname: "new", pidAlive: () => false }, f.io), /не является ссылкой/);
  assert.equal(f.deleted.length, 0);
});
