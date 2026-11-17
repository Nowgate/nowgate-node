# Releasing

1. Set the version in `package.json`, and move `CHANGELOG.md`'s
   "Unreleased" section under it.
2. Push a tag `v<version>` on that commit. The **Release** workflow checks the tag against the
   version, runs the tests, and publishes `nowgate` to npm with provenance (the repository secret
   `NPM_TOKEN`).
3. Check the registry: `npm view nowgate version`.
