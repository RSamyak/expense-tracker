// A folder on this computer as a store of files, with the same three methods as github.js.
// Needs the browser's File System Access API (Chrome, Edge, Arc).
import { RemoteError } from "./github.js";

// A file's "sha" is where and when it last changed, which is enough to tell that it did.
const stamp = (path, file) => `${path}:${file.lastModified}:${file.size}`;

export function createFolder(root) {
  const seen = new Map();

  async function walk(dir, prefix, found) {
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith(".")) continue;
      const path = prefix + name;
      if (handle.kind === "directory") await walk(handle, `${path}/`, found);
      else if (name.endsWith(".json")) {
        const sha = stamp(path, await handle.getFile());
        found.set(path, sha);
        seen.set(sha, handle);
      }
    }
  }

  async function open(path, create) {
    const parts = path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(parts.at(-1), { create });
  }

  return {
    async files() {
      if ((await root.queryPermission({ mode: "readwrite" })) !== "granted") throw new RemoteError(403, "Allow access to the folder first.");
      const found = new Map();
      await walk(root, "", found);
      if (found.has("trip.json")) throw new RemoteError(400, `${root.name} is a single trip.  Choose the folder that holds the trips instead.`);
      return found;
    },
    async read(sha) {
      return (await seen.get(sha).getFile()).text();
    },
    // Creates the file, or replaces it if `sha` is its current sha.  Returns the new sha.
    async write(path, text, message, sha) {
      const handle = await open(path, true);
      const file = await handle.getFile();
      if (file.size && stamp(path, file) !== sha) throw new RemoteError(409, `${path} changed in the folder`);
      const out = await handle.createWritable();
      await out.write(text);
      await out.close();
      const next = stamp(path, await handle.getFile());
      seen.set(next, handle);
      return next;
    },
  };
}

// ---- The chosen folder, kept across visits -------------------------------

const database = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open("expense-tracker", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("folder");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

async function remember(mode, act) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = act(db.transaction("folder", mode).objectStore("folder"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const canPickFolder = () => "showDirectoryPicker" in window;
export const savedFolder = () => remember("readonly", (store) => store.get("root"));
export const forgetFolder = () => remember("readwrite", (store) => store.delete("root"));

export async function pickFolder() {
  const handle = await showDirectoryPicker({ id: "expense-tracker", mode: "readwrite" });
  await remember("readwrite", (store) => store.put(handle, "root"));
  return handle;
}

// Re-asks for access, which the browser only allows from a click.
export const allowFolder = async (handle) => (await handle.requestPermission({ mode: "readwrite" })) === "granted";
