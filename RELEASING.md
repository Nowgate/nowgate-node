# Releasing

Nowgate releases this package from its own server, whose npm token may publish `nowgate`
and works from that server only.

1. Set the version in `package.json`, and move `CHANGELOG.md`'s "Unreleased" section under it.
2. On the server, publish it and tag the commit `v<version>`.
3. Check the registry: `npm view nowgate version`.
