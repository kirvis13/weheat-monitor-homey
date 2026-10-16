# Contributing

Thanks for helping. A few rules keep this public repository tidy.

## Commits

- Every commit on `main` is authored by the maintainer with a GitHub noreply address:
  `kirvis13 <7209653+kirvis13@users.noreply.github.com>` (or `kirvis13@users.noreply.github.com`,
  which the GitHub website uses). Commits made on the website are committed by `GitHub`.
- Pull requests are squash-merged, so your commits in a pull request may carry your own name.
- No co-author or session trailers in commit messages (`Co-Authored-By:`, `...-Session:`), and no
  "generated with" lines in pull requests, release notes or issues.
- Never a real e-mail address in a commit.
- The CI job `authorship` in `.github/workflows/validate.yml` checks this on every push to `main`.

## Versions and releases

- `const VERSIE` at the top of `weheat-monitor.js` holds the version (Semantic Versioning).
- Every change a user notices: bump the version and add an entry at the top of `CHANGELOG.md`, in
  the same commit.
- A release is a tag `vX.Y.Z` equal to `VERSIE`, plus a GitHub release with the CHANGELOG entry as
  its text. The maintainer creates releases; CI checks that the tag matches the script.

## Checks

```bash
bun run test/script.test.ts
```

The test runs the real script (and `controle.js`) the way HomeyScript does (no `AbortController`, settings in
`args[0]`), against a fake Homey and a fake server. Keep each script one file without imports: users
paste it as a whole.

## The API

The script talks to one endpoint, `POST /api/v1/devices/sync` on weheat-monitor.nl, with the key as
`Authorization: Bearer whm_...`. It follows the same rules as the Home Assistant integration
([kirvis13/weheat-monitor-ha](https://github.com/kirvis13/weheat-monitor-ha)); a change to a
steering rule there belongs here too.
