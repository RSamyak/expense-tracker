// Makes this device and the repo hold the same files.
//
// Events only ever add, so merging is a union.  Trip settings are one file;
// if two devices change them at once, the repo's copy is kept.
import { fileOf, isSlug } from "./store.js";

const TRIP_FILE = /^([^/]+)\/trip\.json$/;
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function parallel(items, work, width = 8) {
  const results = [];
  for (let i = 0; i < items.length; i += width) results.push(...(await Promise.all(items.slice(i, i + width).map(work))));
  return results;
}

export async function sync(store, remote) {
  const files = await remote.files();
  const notices = [];
  let pulled = 0;
  let pushed = 0;

  async function settings(slug) {
    const path = `${slug}/trip.json`;
    const sha = files.get(path);
    const meta = store.meta(slug);
    const local = store.trip(slug);
    if (sha && sha !== meta.tripSha) {
      if (local && meta.tripDirty) notices.push(`${local.name}: settings were changed on another device, and those were kept`);
      store.receiveTrip(slug, JSON.parse(await remote.read(sha)), sha);
    } else if (local && (meta.tripDirty || !sha)) {
      const next = await remote.write(path, pretty(local), `${slug}: settings`, sha);
      store.setMeta(slug, { tripSha: next, tripDirty: JSON.stringify(store.trip(slug)) !== JSON.stringify(local) });
    }
  }

  async function events(slug) {
    const folder = `${slug}/events/`;
    const there = new Map([...files].filter(([path]) => path.startsWith(folder)).map(([path, sha]) => [path.slice(folder.length), sha]));
    const here = new Set([...store.events(slug).map(fileOf), ...store.meta(slug).pushed]);

    const missing = [...there].filter(([file]) => !here.has(file));
    const arrived = await parallel(missing, async ([file, sha]) => {
      try {
        return { file, event: JSON.parse(await remote.read(sha)) };
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        notices.push(`${slug}: ${file} is not valid JSON, so it was skipped`);
        return { file, event: null };
      }
    });
    store.addEvents(slug, arrived.filter(({ event }) => event).map(({ event }) => event));
    store.markPushed(slug, arrived.map(({ file }) => file));
    pulled += arrived.length;

    // A lock is only a safety catch, so the device keeps receiving and sends nothing until it opens.
    if (store.trip(slug)?.locked) return;
    for (const event of store.unpushed(slug)) {
      const file = fileOf(event);
      if (!there.has(file)) {
        await remote.write(`${folder}${file}`, pretty(event), `${slug}: ${event.kind} ${event.entry}${event.description ? ` ${event.description}` : ""}`);
        pushed += 1;
      }
      store.markPushed(slug, [file]);
    }
  }

  const remoteSlugs = [...files.keys()].map((path) => TRIP_FILE.exec(path)?.[1]).filter((slug) => slug && isSlug(slug));
  for (const slug of new Set([...store.slugs(), ...remoteSlugs])) {
    await settings(slug);
    await events(slug);
  }
  return { pulled, pushed, notices };
}
