# Expense tracker

Shared expenses for a group, settled across currencies.  The app is at [rsamyak.github.io/expense-tracker](https://rsamyak.github.io/expense-tracker/).

Trips live in a data repo you own.  This repo is only the app.  Each device keeps a copy and syncs when online.

## Your data repo

Start from the [template](https://github.com/RSamyak/expense-tracker-template-data).  It is a working repo with one sample trip, Asha, Bala, and Chitra.  On GitHub, use it as a template and make the new repo private.  Or clone it and push it to a private repo of your own.

The repo holds one folder per trip.  `<trip>/trip.json` is the settings.  `<trip>/events/<time>-<entry>.json` is one version of an entry.  Further trips are created in the app, and written into the repo on the next sync.  The app only adds files, so it never overwrites one the repo already has.

### GitHub

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new).  Limit it to the data repo, and set Contents to read and write.
2. Open the app.  Settings, Sync: paste `owner/repo` and the token, then Connect.  The sample trip arrives.
3. Share link sends the group a link with the token and a name (`who`).  The name is only the label on commits.  It is not a member.  On iPhone, open the link in Safari and add it to the Home Screen.  The icon keeps the link.  Safari's sign-in does not carry over.

Revoke the token when the trip is over.

### A folder

In Chrome, Edge, or Arc: Settings, Sync, Choose folder, and pick a checkout of the data repo.  This keeps the trips on this computer, with no token and no network.  What you change shows up in `git diff`.  The browser may ask for the folder again on a later visit.

Pick the folder that holds the trips.  Any folder of trip folders works, git checkout or not.

Lock a trip in Settings to stop edits from every device.  Unlock it the same way.  The files stay editable by hand.

## Files

- `ledger.js`: the accounting, with no DOM, storage, or network.
- `store.js`: what a device keeps.
- `github.js`: the data repo, through GitHub's API.
- `folder.js`: a folder on disk, with the same three methods.
- `sync.js`: keeps the device a copy of the repo, plus what it has not sent.
- `index.html`: the app.  `sw.js` lets it open offline.

## Test

```sh
node --test
```
