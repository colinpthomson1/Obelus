# Security policy

Do not open a public issue for a suspected vulnerability. Use GitHub's
**Security → Report a vulnerability** flow for
[colinpthomson1/Obelus](https://github.com/colinpthomson1/Obelus/security/advisories/new).
Include affected versions, impact, reproduction steps, and any proposed
mitigation. Please avoid accessing data that is not yours.

Obelus is a local agent that can execute commands and connect to external tools
with the user's authority. Review extensions and generated actions, isolate
untrusted work, keep confirmation enabled for consequential operations, and do
not provide secrets that a task does not require.

This public repository covers the desktop client, embedded Rust agent, and
public interoperability contracts. Reports about the private hosted gateway or
administrator console may use the same private reporting channel; do not
include hosted-service details in a public issue.

Obelus is derived from Goose, but security reports for Obelus should be sent to
Obelus maintainers. Vulnerabilities that also affect upstream Goose may require
coordinated disclosure after triage.
