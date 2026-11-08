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
  const meta = (slug) => read(key("sync", slug), { tripSha: null, tripDirty: false, pushed: [] });
  const setMeta = (slug, changes) => write(key("sync", slug), { ...meta(slug), ...changes });

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
    markPushed(slug, files) {
      setMeta(slug, { pushed: [...new Set([...meta(slug).pushed, ...files])] });
    },
    unpushed(slug) {
      const pushed = new Set(meta(slug).pushed);
      return read(key("events", slug), []).filter((event) => !pushed.has(fileOf(event)));
    },
    pending(slug) {
      return this.unpushed(slug).length + (meta(slug).tripDirty ? 1 : 0);
    },

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
