# Contributing

## Development rules

- Keep extension-owned code dependency-free unless a dependency materially improves correctness and is bundled into the release artifact.
- Do not add `eval`, `new Function`, remotely loaded extension code, or hidden network routing.
- Preserve the strict layout outer response contract: exactly `css` and `javascript` strings.
- Keep user-provided code execution inside `chrome.userScripts`.
- Add or update a contract test for every parser, storage, route, or injection behavior change.
- Avoid adding a hosted dependency to the open-source path. New premium capabilities belong behind the backend adapter seam.

## Local validation

```bash
npm run check
```

Then complete the relevant cases in [docs/compatibility.md](docs/compatibility.md) using an unpacked Chrome build.

## Pull requests

Describe the user-visible change, compatibility impact, manifest permission changes, and validation performed. Changes to the user-script wrapper, GM bridge, remote resource handling, or model payload validator require a security-focused review.
