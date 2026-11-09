// Makes this device a copy of the repo, plus what it has not sent yet.
//
// The repo is the truth.  Every file it lists comes with a sha; a file whose sha is new here is read
// again, and a file it no longer lists is dropped here.  This device only ever adds event files, and
// the repo refuses to create one that exists, so nothing here can overwrite the repo.  Trip settings
// are one file, replaced only against the sha this device last saw; if they moved, the repo's are kept.
import { fileOf, isSlug } from "./store.js";

const TRIP_FILE = /^([^/]+)\/trip\.json$/;
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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

  // Whether the trip is still here afterwards.
  async function settings(slug) {
    const path = `${slug}/trip.json`;
    const sha = files.get(path);
    const meta = store.meta(slug);
    const local = store.trip(slug);
    if (!sha && meta.tripSha) {
      const unsent = store.pending(slug);
      notices.push(`${local?.name ?? slug} is no longer in the repo, so it was removed here${unsent ? `, with ${plural(unsent, "unsent change")}` : ""}`);
      store.forget(slug);
      return false;
    }
    if (sha && sha !== meta.tripSha) {
      if (local && meta.tripDirty) notices.push(`${local.name}: settings were changed on another device, and those were kept`);
      store.receiveTrip(slug, JSON.parse(await remote.read(sha)), sha);
    } else if (local && (meta.tripDirty || !sha)) {
      const next = await remote.write(path, pretty(local), `${slug}: settings`, sha);
      store.setMeta(slug, { tripSha: next, tripDirty: JSON.stringify(store.trip(slug)) !== JSON.stringify(local) });
    }
    return true;
  }

  async function events(slug) {
    const folder = `${slug}/events/`;
    const there = new Map([...files].filter(([path]) => path.startsWith(folder)).map(([path, sha]) => [path.slice(folder.length), sha]));
    const { seen } = store.meta(slug);
    const changed = [...there].filter(([file, sha]) => seen[file] !== sha);
    const gone = Object.keys(seen).filter((file) => !there.has(file));
    const arrived = await parallel(changed, async ([file, sha]) => {
      try {
        return { file, sha, event: JSON.parse(await remote.read(sha)) };
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        notices.push(`${slug}: ${file} is not valid JSON, so it was skipped`);
        return { file, sha, event: null };
      }
    });
    store.receiveEvents(slug, arrived, gone);
    pulled += arrived.length + gone.length;

    // A lock is only a safety catch, so the device keeps receiving and sends nothing until it opens.
    if (store.trip(slug)?.locked) return;
    for (const event of store.unpushed(slug)) {
      const file = fileOf(event);
      const sha = await remote.write(`${folder}${file}`, pretty(event), `${slug}: ${event.kind} ${event.entry}${event.description ? ` ${event.description}` : ""}`);
      store.markSent(slug, file, sha);
      pushed += 1;
    }
  }

  const remoteSlugs = [...files.keys()].map((path) => TRIP_FILE.exec(path)?.[1]).filter((slug) => slug && isSlug(slug));
  for (const slug of new Set([...store.slugs(), ...remoteSlugs])) {
    if (await settings(slug)) await events(slug);
  }
  return { pulled, pushed, notices };
}
