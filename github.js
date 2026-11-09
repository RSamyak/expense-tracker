// A private GitHub repo as a store of files, through GitHub's REST API.

export class RemoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const encode = (text) => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));
const decode = (base64) => new TextDecoder().decode(Uint8Array.from(atob(base64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

export function createRemote({ repo, token }, request = fetch) {
  async function api(path, init = {}) {
    const response = await request(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new RemoteError(response.status, body.message ?? response.statusText);
    return body;
  }

  let branch;
  return {
    // Every file in the repo, as path → content sha.  A partial list would read as files deleted, so it fails.
    async files() {
      branch ??= (await api("")).default_branch;
      let listing;
      try {
        listing = await api(`/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      } catch (error) {
        if (error.status === 409) return new Map();
        throw error;
      }
      if (listing.truncated) throw new RemoteError(413, "The repo is too big to list in one go.");
      return new Map(listing.tree.filter(({ type }) => type === "blob").map(({ path, sha }) => [path, sha]));
    },
    async read(sha) {
      return decode((await api(`/git/blobs/${sha}`)).content);
    },
    // Creates the file, or replaces it if `sha` is its current sha.  Returns the new sha.
    // `author` is { name, email }.  It is both author and committer, so the history names that person
    // rather than the account that owns the token.
    async write(path, text, message, sha, author) {
      const body = { message, content: encode(text), branch, ...(sha && { sha }), ...(author && { author, committer: author }) };
      return (await api(`/contents/${path}`, { method: "PUT", body: JSON.stringify(body) })).content.sha;
    },
  };
}
