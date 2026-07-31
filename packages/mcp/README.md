# `@openzaps/mcp`

`@openzaps/mcp@0.1.0` is published with an npm provenance attestation. Verify the
registry version and attestation again before changing the install command or
publishing a later release.

```json
{
  "mcpServers": {
    "openzaps": {
      "command": "npx",
      "args": ["-y", "@openzaps/mcp@0.1.0"]
    }
  }
}
```

The server discovers capsules and produces block-pinned policy simulations. It
has no signing, intent-publishing, relay, or broadcast tool.

Its discovery tools are bounded and keyset-paginated:

- `list_intents` filters by owner, capsule, executor, or status; it defaults to
  50 records and caps each page at 100.
- `list_agent_connections` defaults to 25 records and caps each page at 50.
- Both return `nextCursor` and `incomplete`. Pass a non-null cursor into the
  next call; `incomplete: true` means the returned page is not the complete
  result set.

The server enforces its advertised JSON Schemas at runtime before any HTTP
request, including required fields, unexpected fields, address formats, string
patterns, and numeric bounds. API bodies are byte-capped before JSON parsing;
profile, capsule, intent, and connection results are then projected into
bounded validated shapes before entering model context.

From a repository checkout, validate the packaged entrypoint with
`node packages/mcp/index.mjs tools`. Set
`NEXT_PUBLIC_OPENZAPS_AGENT_KIT_PUBLISHED=true` on a web deployment only after
verifying the registry version and provenance; absent or any other value keeps
that deployment's install surface hidden.

Optional environment variables:

- `OPENZAPS_APP_URL`: API origin; defaults to `https://www.0xzaps.com`.
- `OPENZAPS_AGENT_ADDRESS`: optional public address shown by
  `agent_identity`. The server never derives it from a private key.
