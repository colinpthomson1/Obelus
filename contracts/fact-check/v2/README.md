# Fact-check contract V2

`assessment.schema.json` is the canonical cross-runtime assessment contract. `fact-check-packet.schema.json` keeps factual assessments separate from operational failure states. TypeScript and Rust implementations should consume the schemas and the fixtures in `fixtures/` as conformance inputs rather than redefining findings independently.

The policy version is `obelus-assessment-policy/2.0.0`. A policy-version change requires new conformance fixtures and explicit compatibility handling.

## Consume the contract

This directory is a standalone data package at version `2.0.0`. It exports both JSON Schemas and the conformance fixtures without bundling gateway implementation or private policy infrastructure.

To inspect the exact package artifact:

```bash
cd contracts/fact-check/v2
npm pack --dry-run
```

Within a checkout, JavaScript consumers can depend on this directory as a `file:` package and resolve `@obelus/fact-check-contract/assessment` or `@obelus/fact-check-contract/fact-check-packet`. Other runtimes can consume the JSON Schema files directly.

Registry publication is disabled until Obelus establishes and reviews a
first-party package destination. `npm pack` remains available for conformance
and release-boundary checks.
