import test from "node:test";
import assert from "node:assert/strict";
import { createRemote, RemoteError } from "./github.js";

// GitHub, as far as this adapter uses it.
function github() {
  const blobs = new Map();
  const request = async (url, { method = "GET", body, headers }) => {
    assert.equal(headers.Authorization, "Bearer t0ken");
    const path = new URL(url).pathname.replace("/repos/o/r", "");
    const reply = (status, value) => ({ ok: status < 300, status, statusText: "", json: async () => value });
    if (path === "") return reply(200, { default_branch: "main" });
    if (path === "/git/trees/main") return reply(200, { tree: [...blobs.keys()].map((sha) => ({ type: "blob", path: `${sha}.json`, sha })), truncated: request.truncated });
    if (path.startsWith("/git/blobs/")) return reply(200, { content: blobs.get(path.slice(11)) });
    if (method === "PUT") {
      request.sent = JSON.parse(body);
      const sha = `s${blobs.size}`;
      blobs.set(sha, request.sent.content);
      return reply(201, { content: { sha } });
    }
    return reply(404, { message: "Not Found" });
  };
  return request;
}

test("files go up and come back unchanged, whatever the script", async () => {
  const remote = createRemote({ repo: "o/r", token: "t0ken" }, github());
  const text = '{"description":"Phở ₹ 🍜"}\n';
  const sha = await remote.write("x.json", text, "add");
  assert.deepEqual([...(await remote.files())], [[`${sha}.json`, sha]]);
  assert.equal(await remote.read(sha), text);
});

test("a named author is written as both author and committer", async () => {
  const request = github();
  const remote = createRemote({ repo: "o/r", token: "t0ken" }, request);
  const person = { name: "Asha", email: "asha@expense.invalid" };
  await remote.write("x.json", "{}\n", "add", undefined, person);
  assert.deepEqual(request.sent.author, person);
  assert.deepEqual(request.sent.committer, person);
});

test("a listing GitHub cut short is refused, never taken as files deleted", async () => {
  const request = github();
  request.truncated = true;
  const remote = createRemote({ repo: "o/r", token: "t0ken" }, request);
  await assert.rejects(remote.files(), (error) => error instanceof RemoteError && error.status === 413);
});

test("failures carry the status", async () => {
  const remote = createRemote({ repo: "o/r", token: "t0ken" }, github());
  await assert.rejects(remote.read("missing/../../nope"), (error) => error instanceof RemoteError && error.status === 404);
});
