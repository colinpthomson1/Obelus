# Obelus release status

Obelus does not currently publish signed desktop, CLI, package-registry, or
container releases. The inherited Goose updater, registries, signing
destinations, and release automation are intentionally disabled.

Before the first public release, maintainers must establish and review:

1. Obelus-owned artifact, package, container, and updater destinations.
2. Immutable versioning and checksums for every downloadable artifact.
3. Platform signing and notarization under Obelus-controlled identities.
4. Separate Obelus bundle IDs, URL schemes, storage, keyrings, analytics, and
   update channels.
5. Reproducible CI, software-bill-of-materials generation, dependency and
   artifact scanning, and provenance.
6. A rollback plan and the manual verification in
   [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
7. Professional naming and trademark clearance for public distribution.

Until those gates are complete, build locally from a reviewed commit. Do not
substitute upstream Goose binaries or mutable \`latest\` assets and present
them as Obelus.
