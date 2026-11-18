# prusa-connect

Upstream [Prusa Connect](https://github.com/prusa3d/prusa-connect), the self-hosted print server, rebuilt with the PostgreSQL driver and the Prometheus `/metrics` exposition. Published to `ghcr.io/ryanbtv/prusa-connect` for `linux/amd64` and `linux/arm64`.

## Why this image exists

Upstream publishes `ghcr.io/prusa3d/prusa-connect`, but that image is built with only the `full` and `diagnostics` Go build tags. Its Dockerfile derives the tags from the sample `config/config.yaml`, which selects SQLite and leaves observability off. So the upstream image:

- refuses `persistence.type: postgres` at startup, because the driver is behind the `postgres` build tag
- answers 404 at `/metrics`, because the Prometheus client is behind the `observability` build tag

The upstream release binaries are built with `-tags full,diagnostics,observability,postgres`. This image takes the upstream image and replaces only `/prusa_connect` with the release binary of the same version.

## How this image is built

1. The `fetch` stage downloads `prusa_connect_amd64` or `prusa_connect_aarch64` from the upstream GitHub release and checks it against a pinned SHA-256.
2. The final stage starts from `ghcr.io/prusa3d/prusa-connect:<version>`, applies pending Debian security updates, and copies the binary over `/prusa_connect`.

Everything else comes from upstream unchanged: the base OS, the runtime user `prusa` (uid/gid 10001), the CA bundle, the modules in `/opt/modules`, `ENTRYPOINT ["/prusa_connect"]`, and `CMD ["core"]`.

The Debian upgrade step exists because the upstream base layer trails Debian security updates, and the Trivy gate in this repository blocks on fixed `CRITICAL` and `HIGH` findings.

## Tags

`TAG` holds the upstream version. A push to `main` publishes `ghcr.io/ryanbtv/prusa-connect:<version>`, plus `latest` and `sha-<short>`.

## Upgrading

1. Read the upstream [releases](https://github.com/prusa3d/prusa-connect/releases) and their notes. The project is a beta, and its configuration keys can change between releases.
2. Set `PRUSA_CONNECT_VERSION` in the `Dockerfile` to the new version.
3. Copy the `prusa_connect_amd64` and `prusa_connect_aarch64` lines of the release's `SHA256SUMS` into `SHA256_AMD64` and `SHA256_ARM64`.
4. Write the new version into `TAG`.
5. Open a pull request. The build fails at `sha256sum -c` if a checksum does not match the downloaded binary.

Check the build tags of a built image with:

```sh
docker run --rm prusa-connect:test -version -json
```

## License

Upstream is source-available under OCL v1.1 + Micro v1 + NoSaaS v1 + SWAtt v1. Personal, non-commercial self-hosting is allowed. This directory adds build automation only and vendors no upstream source.
