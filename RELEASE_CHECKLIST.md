# Obelus release checklist

This checklist becomes applicable only after the release prerequisites in
[RELEASE.md](RELEASE.md) are complete.

- [ ] Release commit is protected, reviewed, and fully green in CI.
- [ ] Version and release notes match every platform artifact.
- [ ] Rust, desktop, public-contract, migration, and packaging checks pass.
- [ ] Artifacts are signed, notarized where required, scanned, and accompanied
      by checksums, provenance, and an SBOM.
- [ ] A clean machine installs and launches without reading Goose storage,
      sessions, keyrings, analytics, or update channels.
- [ ] Microphone, recording, privacy, provider, and hosted-research disclosures
      match actual behavior.
- [ ] Upgrade, downgrade, rollback, and uninstall paths are exercised without
      silently losing user data.
- [ ] All external URLs, OAuth identities, provider headers, artifact sources,
      and support contacts are Obelus-owned or explicitly labeled
      compatibility dependencies.
- [ ] The release does not contain credentials, local environment files,
      customer content, managed-service source, or private evaluation assets.
- [ ] Public naming and trademark clearance is documented.
