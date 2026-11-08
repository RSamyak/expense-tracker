import test from "node:test";
import assert from "node:assert/strict";
import { createStore, fileOf } from "./store.js";
import { sync } from "./sync.js";

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

// A repo in memory, refusing a replace whose sha is stale, as GitHub does.
function repo() {
  const files = new Map();
  let version = 0;
  return {
    files: async () => new Map([...files].map(([path, { sha }]) => [path, sha])),
    read: async (sha) => [...files.values()].find((file) => file.sha === sha).text,
    async write(path, text, message, sha) {
      if (files.has(path) && files.get(path).sha !== sha) throw Object.assign(new Error("conflict"), { status: 409 });
      files.set(path, { sha: `sha${version++}`, text });
      return files.get(path).sha;
    },
    paths: () => [...files.keys()].sort(),
  };
}

const trip = { schemaVersion: 1, name: "Thailand", base: "INR", currencies: {}, members: [{ id: "a", name: "Asha" }], categories: [] };
const event = (entry, at) => ({ entry, at, by: "a", kind: "expense", date: "2026-12-14", currency: "INR", paid: { a: "10" } });

test("one device's trip and entries reach another", async () => {
  const remote = repo();
  const phone = createStore(memory());
  phone.saveTrip("2026-thailand", trip);
  phone.addEvents("2026-thailand", [event("x", "2026-12-14T10:00:00.000Z")]);
  assert.equal(phone.pending("2026-thailand"), 2);

  assert.deepEqual(await sync(phone, remote), { pulled: 0, pushed: 1, notices: [] });
  assert.equal(phone.pending("2026-thailand"), 0);
  assert.deepEqual(remote.paths(), ["2026-thailand/events/2026-12-14T10-00-00-000Z-x.json", "2026-thailand/trip.json"]);

  const laptop = createStore(memory());
  assert.deepEqual(await sync(laptop, remote), { pulled: 1, pushed: 0, notices: [] });
  assert.deepEqual(laptop.trip("2026-thailand"), trip);
  assert.deepEqual(laptop.events("2026-thailand"), phone.events("2026-thailand"));
  assert.equal(laptop.pending("2026-thailand"), 0);
});

test("entries made apart are merged, and nothing is sent twice", async () => {
  const remote = repo();
  const [one, two] = [createStore(memory()), createStore(memory())];
  one.saveTrip("2026-thailand", trip);
  await sync(one, remote);
  await sync(two, remote);
  one.addEvents("2026-thailand", [event("x", "2026-12-14T10:00:00.000Z")]);
  two.addEvents("2026-thailand", [event("y", "2026-12-14T10:00:01.000Z")]);
  await sync(one, remote);
  await sync(two, remote);
  await sync(one, remote);
  const entries = (store) => store.events("2026-thailand").map(fileOf).sort();
  assert.deepEqual(entries(one), entries(two));
  assert.equal(entries(one).length, 2);
  assert.deepEqual(await sync(one, remote), { pulled: 0, pushed: 0, notices: [] });
});

test("a locked trip still receives entries, and sends none until it opens", async () => {
  const remote = repo();
  const keeper = createStore(memory());
  keeper.saveTrip("1901-sample", { ...trip, locked: true });
  await sync(keeper, remote);
  assert.deepEqual(remote.paths(), ["1901-sample/trip.json"]);

  const phone = createStore(memory());
  await sync(phone, remote);
  phone.addEvents("1901-sample", [event("x", "1901-06-01T10:00:00.000Z")]);
  assert.deepEqual(await sync(phone, remote), { pulled: 0, pushed: 0, notices: [] });
  assert.equal(phone.pending("1901-sample"), 1);

  const opened = phone.trip("1901-sample");
  delete opened.locked;
  phone.saveTrip("1901-sample", opened);
  assert.equal((await sync(phone, remote)).pushed, 1);
  assert.equal(phone.pending("1901-sample"), 0);
});

test("when settings clash, the repo's copy is kept and said so", async () => {
  const remote = repo();
  const [one, two] = [createStore(memory()), createStore(memory())];
  one.saveTrip("2026-thailand", trip);
  await sync(one, remote);
  await sync(two, remote);
  one.saveTrip("2026-thailand", { ...trip, name: "Thailand trip" });
  two.saveTrip("2026-thailand", { ...trip, name: "Bangkok" });
  await sync(one, remote);
  const { notices } = await sync(two, remote);
  assert.equal(notices.length, 1);
  assert.equal(two.trip("2026-thailand").name, "Thailand trip");
  assert.equal(two.pending("2026-thailand"), 0);
});
