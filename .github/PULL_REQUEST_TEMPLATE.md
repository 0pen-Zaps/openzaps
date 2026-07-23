<!--
  Thanks for contributing to OpenZaps.
  Do NOT report a security vulnerability here — see SECURITY.md for private disclosure.
-->

## What and why

<!-- What does this change, and why? Link any issue with "Closes #123". -->

## Checklist

- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build` pass locally
- [ ] Contracts touched? `forge build` and `forge test` pass (fork tests with an RPC)
- [ ] No secrets, keys, or `.env` files are added (CI will also check)
- [ ] No invented data — failed reads show nothing or an honest error, never fake rows
- [ ] User-visible behavior changes are described above
