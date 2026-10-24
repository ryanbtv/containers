# arc-runner

Runner image for a self-hosted ARC (Actions Runner Controller) scale set. Use it as the image of the `runner` container in the scale set's `template.spec`, in dind mode.

Published as `ghcr.io/ryanbtv/arc-runner`, for `linux/amd64` and `linux/arm64`.

## What it adds

The base is the official `ghcr.io/actions/actions-runner`, pinned by tag and digest. It keeps `jq`, `git`, `curl`, `unzip`, the entrypoint, and `/home/runner` unchanged. The image adds:

- `gh`, from the official `cli.github.com` apt repository. The build checks the keyring SHA-256.
- `python3`.
- `libatomic1`, which the Node binaries from `actions/setup-node` need.
- The Docker Compose v2 plugin, a pinned static binary in `/usr/local/lib/docker/cli-plugins/docker-compose`. The build checks its SHA-256 per architecture.

The image runs as `runner`.

## Bumping

1. Runner: set the new tag and digest in the `FROM` line. Get the digest with `crane digest ghcr.io/actions/actions-runner:<version>`.
2. Compose: set `COMPOSE_VERSION` and both `COMPOSE_SHA256_*` values from the release's `checksums.txt`.
3. gh keyring: if the key rotates, update `GH_KEYRING_SHA256`.
4. Set `TAG` to `<runner-version>-<n>`. Reset `n` to 1 on a runner bump, and increment it for any other change.
5. Open a pull request. The merge publishes `ghcr.io/ryanbtv/arc-runner:<TAG>`.
