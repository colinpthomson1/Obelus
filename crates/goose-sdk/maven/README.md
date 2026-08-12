# Obelus Goose-compatible SDK Maven package

This project packages the UniFFI-generated Kotlin/JVM bindings for `goose-sdk`
as the Maven artifact `io.github.aaif-goose:gdk`.

The artifact version is read from `crates/goose-sdk/Cargo.toml`, so it stays in
lockstep with the Rust crate version. The jar includes the generated Kotlin API
and native libraries under JNA platform resource directories. Packaging supports
`darwin-aarch64`, `darwin-x86-64`, `linux-x86-64`, `linux-aarch64`, and
`win32-x86-64` resource prefixes; CI is responsible for assembling every native
library into the final local jar.

Build locally from the repository root:

```bash
just --justfile crates/goose-sdk/justfile maven-package
```

The compatibility coordinates are retained for local consumers. Maven Central
publishing is disabled in this repository; the `maven-publish` recipe fails
closed even when registry credentials are present.
