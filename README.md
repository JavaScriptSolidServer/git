# JSS Git

Web-based git browser for Solid pods. Browse any pod-hosted git repository (or any git remote) in a recognizable UI.

Live: https://jss.live/git/

## Architecture

- **Preact + HTM** standalone (no build step, ESM imports from CDN)
- **isomorphic-git** for browser-side git operations
- Single `index.html` — view source to read the whole app

JSS pods expose git smart-HTTP (`/info/refs`, `/git-upload-pack`, `/git-receive-pack`) so any pod is a git remote. This frontend is the UI layer.

## Usage

```
https://jss.live/git/?repo=https://your.pod/path/repo
```

## Roadmap

- [x] List refs (branches, tags) — v0
- [ ] File tree view (HEAD)
- [ ] README rendering
- [ ] Branches dropdown
- [ ] Commit history
- [ ] File content view
- [ ] Optional: did:nostr signature display, git-mark verification

## Tracking

- Issue: [JavaScriptSolidServer/JavaScriptSolidServer#370](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/370)
