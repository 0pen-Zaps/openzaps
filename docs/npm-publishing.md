# npm package publishing

`@openzaps/sdk` and `@openzaps/mcp` publish only through the manual
[`publish-npm.yml`](../.github/workflows/publish-npm.yml) workflow. The job runs only from `main`,
requires an explicit package and version, refuses a version that does not match the reviewed
`package.json`, refuses an already-published version, inspects the tarball, and publishes from a
GitHub-hosted Node 24 runner with full-SHA-pinned release actions, npm 12.0.1, automatic
package-manager caching disabled, and provenance. Update those pins only in a reviewed pull request.

## Repository setup

Create a GitHub environment named `npm-production` with:

- required reviewers;
- deployment branches restricted to `main`; and
- no `NPM_TOKEN` secret after trusted publishing is active.

The workflow deliberately references this environment, so publishing pauses for its protection
rules. A version bump must land through a reviewed pull request before dispatch; the workflow does
not edit manifests or mint versions.

## First release only

npm cannot configure a trusted publisher for a package that does not exist yet. Bootstrap each
package once:

1. Create a short-lived granular npm token that can publish the `@openzaps` package, and store it as
   the `NPM_TOKEN` secret on the protected `npm-production` GitHub environment. Never commit it or
   paste it into a workflow input.
2. From the Actions page on `main`, dispatch `Publish npm package` separately for
   `@openzaps/sdk@0.1.0` and `@openzaps/mcp@0.1.0`. Confirm the environment approval names the exact
   package and version intended.
3. Verify each package page contains the expected version, MIT license, README, and provenance.
4. Configure each npm package's trusted publisher with these exact claims:
   - repository: `0pen-Zaps/openzaps`;
   - workflow filename: `publish-npm.yml`;
   - environment: `npm-production`;
   - allowed action: `npm publish`.

The same trust can be configured from an authenticated local npm CLI:

```sh
npm trust github @openzaps/sdk --file publish-npm.yml --repo 0pen-Zaps/openzaps --env npm-production --allow-publish
npm trust github @openzaps/mcp --file publish-npm.yml --repo 0pen-Zaps/openzaps --env npm-production --allow-publish
```

After both trusted publishers exist, delete the `NPM_TOKEN` environment secret and revoke the token
at npm. Later releases authenticate with the workflow's short-lived OIDC identity; do not restore a
long-lived publish token as a convenience.

## Every release

1. Update only the intended package's version and release notes in a reviewed pull request.
2. Wait for CI on `main`.
3. Dispatch the workflow with the exact package and committed version.
4. Review the `npm-production` approval prompt, then verify the package version and provenance on
   npm after the job completes.
