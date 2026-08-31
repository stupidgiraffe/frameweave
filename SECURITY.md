# Security policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose user scripts, stored keys, page data, or extension privileges. Until a maintainer support address is configured, report privately through the repository owner's GitHub security advisory channel.

Include a minimal reproduction, affected browser/version, expected impact, and any proof-of-concept source needed to verify the issue. Do not include active credentials or private user data.

## Scope

High-priority reports include:

- extension-owned code executing fetched data outside `chrome.userScripts`;
- bypasses of the AI layout payload validator or static automation interpreter;
- cross-script value isolation failures;
- unintended exposure of stored provider keys;
- privilege escalation across extension, user-script, or page worlds.

## Project boundary

Frameweave intentionally executes user-installed scripts, their declared dependencies, and their configured update sources through Chrome's User Scripts API. A malicious script chosen by the user is not a vulnerability in the manager by itself. Reports should demonstrate a violation of the documented isolation or permission model.
