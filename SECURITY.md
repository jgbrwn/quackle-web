# Security policy

Please do not report vulnerabilities in public issues.

Use a private GitHub Security Advisory for this repository. If that mechanism is
unavailable, contact the maintainer through the GitHub account that owns the
repository and include only the minimum reproduction details needed to triage.
Do not send credentials, private user data, or live bearer links in a report.

The project intentionally excludes provider credentials, deployment configuration,
compiled dictionaries, and private runtime state. If a secret is ever committed,
assume it is compromised: revoke/rotate it first, then report the commit so the
history can be handled separately.

Security-sensitive areas include:

- session capability handling and share-link fragments;
- revision/idempotency checks and WebSocket reconciliation;
- GCG and external-link parsing;
- native process argument construction and artifact loading;
- custom-list normalization and compilation boundaries.
