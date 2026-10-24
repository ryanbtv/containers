# openchamber

Container image built from upstream [`openchamber/openchamber`](https://github.com/openchamber/openchamber), published to `ghcr.io/ryanbtv/openchamber`.

Upstream ships a working `Dockerfile` but publishes no container image. There is no `ghcr.io/openchamber/openchamber` package, no Docker Hub repository, and no container job in its release workflow. Building it here is therefore the only way to run OpenChamber from a registry.

## How this image is built

This directory holds no `Dockerfile`. It holds a pointer.

| File | Meaning |
| --- | --- |
| `UPSTREAM_REF` | The upstream git ref to build. A tag, a branch, or a full commit SHA. |

The `openchamber` job in [`docker-build-pipeline.yml`](../../.github/workflows/docker-build-pipeline.yml) reads that file, checks the upstream repository out at that ref into a scratch directory, and builds with the **upstream checkout as the build context**. Every `COPY` in the upstream `Dockerfile` is relative to its own repository root, so no other context works.

A git submodule was considered and rejected. A submodule adds a gitlink that every clone and every checkout must opt into with `submodules: true`, and bumping the version becomes a submodule commit instead of a one-line edit. A ref file gives the same pinning with none of that.

## Upgrading

1. Read the upstream [releases](https://github.com/openchamber/openchamber/releases).
2. Change `UPSTREAM_REF` to the new tag.
3. Open a pull request. The pull request builds and scans without pushing.
4. Merge. The push to `main` publishes `latest`, the version tag, and a `sha-` tag.

Pin a tag, never `main`. Upstream moves several times a week.

## Reproducibility caveat

The upstream `Dockerfile` runs `npm install -g opencode-ai` with no version pin. Two builds of the same `UPSTREAM_REF` on different days therefore produce different images, because each picks up whatever OpenCode CLI is current. There is no scheduled rebuild; run the pipeline manually (`workflow_dispatch`) to refresh it deliberately. Use the `sha-<short>` tag when you need to redeploy the exact image you tested.

Upstream also declares no `ARG`, so nothing about the build is parameterizable. Changing the base image, the port, or the pinned `cloudflared` digest requires patching upstream, not passing a build argument.

## Vulnerability scanning

Trivy runs against this image in report-only mode. It never fails the build.

The image is a Debian-based `oven/bun` with a global npm install layered on it, all of it upstream code. A blocking `CRITICAL,HIGH` gate here would fail on findings that cannot be fixed in this repository, so the scan publishes its findings to the job summary and the build continues. Images written in this repository keep the blocking gate.

## Running it

Upstream `docker-compose.yml` assumes you are sitting in the upstream repository root: it uses `build.context: .` and relative `./data` bind mounts. Do not copy it verbatim. Point a compose file at the published image instead:

```yaml
services:
  openchamber:
    image: ghcr.io/ryanbtv/openchamber:latest
    ports:
      - "3000:3000"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data/openchamber:/home/openchamber/.config/openchamber
      - ./data/opencode/share:/home/openchamber/.local/share/opencode
      - ./data/opencode/state:/home/openchamber/.local/state/opencode
      - ./data/opencode/config:/home/openchamber/.config/opencode
      - ./data/ssh:/home/openchamber/.ssh
      - ./workspaces:/home/openchamber/workspaces
    environment:
      OPENCHAMBER_UI_PASSWORD: ${OPENCHAMBER_UI_PASSWORD:?}
    restart: unless-stopped
```

The container binds `0.0.0.0` on port 3000, so `OPENCHAMBER_UI_PASSWORD` is mandatory. It is a secret. Keep the value in a secret store and inject it at deploy time. Never commit it here.

The runtime user is `openchamber` at UID/GID 1000:1000, so bind-mounted directories must be owned by 1000:1000.

## Registry visibility

The package is published from the public `ryanbtv/containers` repository. Once the package visibility is public, pulling it needs no token.

## License

Upstream is MIT, by Bohdan Triapitsyn. This directory adds build automation only; it vendors no upstream source.
