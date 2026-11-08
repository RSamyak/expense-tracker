# Expense tracker

Shared expenses for a group or trip, settled across currencies.  Live at [rsamyak.github.io/expense-tracker](https://rsamyak.github.io/expense-tracker/).

Trip data lives in a private GitHub repo, never in this one.  Each device keeps a copy and syncs when online.

## Set up a trip

1. Make a fine-grained GitHub token: the private data repo only, Contents read and write.
2. Open the app, create the trip, and fill in Settings.
3. Under Settings, Sync: paste the repo and token, then Connect.
4. Share link sends the others a link that carries the token and a name (`who`).  That name is only the commit label.  It is not a member.  On iPhone, open that link in Safari and add it to the Home Screen.  The icon keeps the link.  Safari's sign-in does not carry over.

Revoke the token after the trip.

## Use a folder instead

On a laptop in Chrome, Edge, or Arc, Settings, Sync, Choose folder keeps the trip files in a folder on disk, with no token and no network.  Point it at a checkout of the data repo to test against real data; changes appear in `git diff`.  The browser may ask for access again on a later visit.

Lock a trip in Settings to stop edits on every device.  Unlock it the same way.  The files themselves stay editable.

## Files

- `ledger.js`: the accounting, with no DOM, storage, or network.
- `store.js`: what a device keeps.
- `github.js`: the private repo, through GitHub's API.
- `folder.js`: a folder on disk, with the same three methods.
- `sync.js`: merges the two.
- `index.html`: the app.  `sw.js` lets it open offline.

Data repo layout: `<trip>/trip.json` and `<trip>/events/<time>-<entry>.json`, one file per version of an entry.

## Test

```sh
node --test
```
