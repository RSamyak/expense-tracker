// Everything this device keeps: trips, their events, sync bookkeeping, and preferences.
const PREFIX = "expense-tracker:1:";
const key = (kind, slug = "") => `${PREFIX}${kind}:${slug}`;

// A short random id for a member or an entry, made on the device that creates it.
export const newId = () => crypto.randomUUID().slice(0, 8);

// A trip's folder in the private repo: the year, then the trip, as in `2026-thailand`.
export const isSlug = (text) => /^\d{4}(-[a-z0-9]+)+$/.test(text);

// Each version of an entry is one file, so devices only ever add files and never collide.
export const fileOf = (event) => `${event.at.replace(/[:.]/g, "-")}-${event.entry}.json`;

export function createStore(storage) {
  const read = (k, fallback) => JSON.parse(storage.getItem(k) ?? "null") ?? fallback;
  const write = (k, value) => storage.setItem(k, JSON.stringify(value));
  const keys = () => Array.from({ length: storage.length }, (_, i) => storage.key(i));
  const TRIP = key("trip");

  // `tripSha` is the repo's trip.json as last seen; `tripDirty` means local edits await upload.
  // `seen` is each event file the repo held when last synced, with its sha.  Events not in it are unsent.
  // Devices from before `seen` kept a `pushed` list instead; those files count as seen, sha unknown.
  const meta = (slug) => {
    const { pushed = [], ...kept } = read(key("sync", slug), {});
    return { tripSha: null, tripDirty: false, seen: Object.fromEntries(pushed.map((file) => [file, null])), ...kept };
  };
  const setMeta = (slug, changes) => write(key("sync", slug), { ...meta(slug), ...changes });
  const forget = (slug) => ["trip", "events", "sync"].forEach((kind) => storage.removeItem(key(kind, slug)));

  return {
    slugs: () => keys().filter((k) => k.startsWith(TRIP)).map((k) => k.slice(TRIP.length)).sort().reverse(),
    trip: (slug) => read(TRIP + slug, null),
    saveTrip(slug, trip) {
      write(TRIP + slug, trip);
      setMeta(slug, { tripDirty: true });
    },

    events: (slug) => read(key("events", slug), []),
    addEvents(slug, events) {
      write(key("events", slug), [...read(key("events", slug), []), ...events]);
    },

    meta,
    setMeta,
    // A copy from the repo, so nothing awaits upload.
    receiveTrip(slug, trip, sha) {
      write(TRIP + slug, trip);
      setMeta(slug, { tripSha: sha, tripDirty: false });
    },
    // Event files as the repo now holds them.  Each arrival replaces any copy here, and each gone file
    // is dropped.  An arrival with no event is a file that could not be read; it is remembered, not kept.
    receiveEvents(slug, arrived, gone) {
      const replaced = new Set([...arrived.map(({ file }) => file), ...gone]);
      const kept = read(key("events", slug), []).filter((event) => !replaced.has(fileOf(event)));
      write(key("events", slug), [...kept, ...arrived.filter(({ event }) => event).map(({ event }) => event)]);
      const seen = { ...meta(slug).seen };
      for (const { file, sha } of arrived) seen[file] = sha;
      for (const file of gone) delete seen[file];
      setMeta(slug, { seen });
    },
    markSent(slug, file, sha) {
      setMeta(slug, { seen: { ...meta(slug).seen, [file]: sha } });
    },
    unpushed(slug) {
      const { seen } = meta(slug);
      return read(key("events", slug), []).filter((event) => !Object.hasOwn(seen, fileOf(event)));
    },
    pending(slug) {
      return this.unpushed(slug).length + (meta(slug).tripDirty ? 1 : 0);
    },
    forget,
    // Every trip goes, to be fetched again; the link and preferences stay.
    reset() {
      this.slugs().forEach(forget);
      storage.removeItem(key("synced"));
    },
    // When this device last matched the repo.
    synced: () => read(key("synced"), null),
    setSynced: (at) => write(key("synced"), at),

    opened: () => read(key("opened"), null),
    open: (slug) => write(key("opened"), slug),

    // The private repo and its token, on this device only.
    link: () => read(key("link"), null),
    setLink: (link) => (link ? write(key("link"), link) : storage.removeItem(key("link"))),

    // Per device and trip: who is using it, and the last currency and payment label.
    prefs: (slug) => read(key("prefs", slug), {}),
    setPrefs: (slug, changes) => write(key("prefs", slug), { ...read(key("prefs", slug), {}), ...changes }),
  };
}
