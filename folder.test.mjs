import test from "node:test";
import assert from "node:assert/strict";
import { createFolder } from "./folder.js";
import { createStore, fileOf } from "./store.js";
import { sync } from "./sync.js";

// A directory in memory, shaped like the browser's FileSystemDirectoryHandle.
function directory(name = "root", permission = "granted") {
  const children = new Map();
  let clock = 1;
  const self = {
    kind: "directory",
    name,
    queryPermission: async () => permission,
    async *entries() {
      yield* children;
    },
    async getDirectoryHandle(part, { create } = {}) {
      if (!children.has(part)) {
        if (!create) throw new Error("not found");
        children.set(part, directory(part));
      }
      return children.get(part);
    },
    async getFileHandle(part, { create } = {}) {
      if (!children.has(part)) {
        if (!create) throw new Error("not found");
        children.set(part, file(part, () => clock++));
      }
      return children.get(part);
    },
    // For the test to read what ended up on disk.
    peek: (path) => path.split("/").reduce((dir, part) => dir.children.get(part), { children }),
    children,
  };
  return self;
}

function file(name, tick) {
  let text = "";
  let modified = 0;
  return {
    kind: "file",
    name,
    get text() {
      return text;
    },
    getFile: async () => ({ lastModified: modified, size: text.length, text: async () => text }),
    createWritable: async () => {
      let next = "";
      return { write: async (chunk) => (next += chunk), close: async () => ([text, modified] = [next, tick()]) };
    },
  };
}

function memory() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i],
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const trip = { schemaVersion: 1, name: "Sample", base: "INR", currencies: {}, members: [{ id: "a", name: "Asha" }], categories: [] };
const event = (entry, at) => ({ entry, at, by: "a", kind: "expense", date: "1901-06-01", currency: "INR", paid: { a: "10" } });

test("files are listed, read, and written, and nested folders are made on demand", async () => {
  const root = directory();
  const remote = createFolder(root);
  const sha = await remote.write("1901-sample/events/x.json", '{"mark":"₹"}\n', "add");
  assert.equal(root.peek("1901-sample/events/x.json").text, '{"mark":"₹"}\n');
  assert.deepEqual([...(await remote.files())], [["1901-sample/events/x.json", sha]]);
  assert.equal(await remote.read(sha), '{"mark":"₹"}\n');
});

test("a file changed behind the app's back is not overwritten", async () => {
  const root = directory();
  const remote = createFolder(root);
  const sha = await remote.write("a/trip.json", "one", "add");
  await createFolder(root).write("a/trip.json", "two", "other", sha);
  await assert.rejects(remote.write("a/trip.json", "three", "late", sha), (error) => error.status === 409);
});

test("hidden folders such as .git are left alone, and access must be granted", async () => {
  const root = directory();
  const remote = createFolder(root);
  await remote.write(".git/config.json", "{}", "x");
  await remote.write("a/trip.json", "{}", "x");
  assert.deepEqual([...(await remote.files())].map(([path]) => path), ["a/trip.json"]);
  await assert.rejects(createFolder(directory("locked", "prompt")).files(), (error) => error.status === 403);
});

test("a single trip's folder is refused, with the way out", async () => {
  const root = directory("2024-vietnam");
  await createFolder(root).write("trip.json", "{}", "x");
  await createFolder(root).write("events/a.json", "{}", "x");
  await assert.rejects(createFolder(root).files(), (error) => error.status === 400 && /holds the trips/.test(error.message));
});

test("two devices stay in step through a folder, and existing files are not rewritten", async () => {
  const root = directory();
  const remote = createFolder(root);
  const one = createStore(memory());
  one.saveTrip("1901-sample", trip);
  one.addEvents("1901-sample", [event("x", "1901-06-01T10:00:00.000Z")]);
  assert.deepEqual(await sync(one, remote), { pulled: 0, pushed: 1, notices: [] });
  const stored = root.peek(`1901-sample/events/${fileOf(event("x", "1901-06-01T10:00:00.000Z"))}`).text;
  assert.deepEqual(JSON.parse(stored), event("x", "1901-06-01T10:00:00.000Z"));

  const two = createStore(memory());
  assert.deepEqual(await sync(two, createFolder(root)), { pulled: 1, pushed: 0, notices: [] });
  assert.deepEqual(two.trip("1901-sample"), trip);
  assert.deepEqual(await sync(two, createFolder(root)), { pulled: 0, pushed: 0, notices: [] });
  assert.deepEqual(await sync(one, createFolder(root)), { pulled: 0, pushed: 0, notices: [] });
});
