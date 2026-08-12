---
name: goose-doc-guide
description: Opt-in compatibility guide for upstream Goose documentation. This is not Obelus documentation. Use it only for an explicitly requested Goose compatibility task after GOOSE_DOCS_ROOT has been configured to a trusted documentation root.
---

This compatibility skill reads **upstream Goose documentation**, not Obelus
documentation. Do not use upstream behavior or branding to describe Obelus.

Use this skill only when both conditions are true:

- The user explicitly asks about upstream Goose compatibility, migration, or an
  unchanged compatibility interface.
- `GOOSE_DOCS_ROOT` was explicitly configured to a documentation root the user
  trusts.

Do not use this skill for general Obelus product questions, general coding
tasks, or as evidence that an upstream Goose feature is available in Obelus.

The explicitly configured upstream docs root for this session is
`{{GOOSE_DOCS_ROOT}}`. It may be a local filesystem path or an HTTP(S) URL. Use
that exact root. Do not substitute another website, fall back to a canonical
online location, or guess documentation paths.

## Steps

1. Read `<docs-root>/goose-docs-map.md` from the configured root.
2. Find the relevant pages in that map.
3. Read only paths explicitly listed in the map.
4. Verify every Goose-specific field, value, name, syntax, and command against
   those pages before answering.
5. Clearly label findings as upstream Goose compatibility information and note
   that Obelus behavior may differ.
6. Cite only the exact documentation pages actually used, preserving the
   configured root rather than rewriting links to another host.

If the configured root cannot be read or does not contain the needed reference,
say that the upstream compatibility information could not be verified. Do not
replace it with assumptions or training data.
