# prusa-connect: upstream Prusa Connect (github.com/prusa3d/prusa-connect)
# with the PostgreSQL driver and the Prometheus /metrics exposition linked in.
#
# The upstream image derives its Go build tags from its sample config, which
# selects SQLite and leaves observability off, so it is built with
# `-tags full,diagnostics` only. It refuses `persistence.type: postgres` at
# startup and answers 404 at /metrics. The upstream release binaries are built
# with `-tags full,diagnostics,observability,postgres`.
#
# This image keeps everything else from the upstream image (base OS, uid/gid
# 10001, CA bundle, /opt/modules, ENTRYPOINT and CMD) and replaces only
# /prusa_connect with the release binary of the same version, verified
# against a pinned SHA-256.
#
# Upgrading: change PRUSA_CONNECT_VERSION and both checksums together. Take
# the checksums from the release's SHA256SUMS. A version bump without new
# checksums fails the build at `sha256sum -c`, on purpose.
#
# Build (the build context is this directory, as the pipeline does):
#   docker build -t prusa-connect:test images/prusa-connect

ARG PRUSA_CONNECT_VERSION=0.1.0-beta.1

FROM alpine:3.22 AS fetch
ARG PRUSA_CONNECT_VERSION
ARG TARGETARCH
ARG SHA256_AMD64=a3a1f69611bc59ec5dad494abd0fd04db7952fd7ac6f519ce0978217e8cf63a5
ARG SHA256_ARM64=767f7ca5402e325fbd875108b86c8d7ecfd2d35e643287a8350abfd5de2b327c
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) asset=prusa_connect_amd64;   sum="${SHA256_AMD64}" ;; \
      arm64) asset=prusa_connect_aarch64; sum="${SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -q -O /prusa_connect \
      "https://github.com/prusa3d/prusa-connect/releases/download/v${PRUSA_CONNECT_VERSION}/${asset}"; \
    echo "${sum}  /prusa_connect" | sha256sum -c -; \
    chmod 0755 /prusa_connect

FROM ghcr.io/prusa3d/prusa-connect:${PRUSA_CONNECT_VERSION}

# The upstream base layer trails Debian security updates, and this
# repository's Trivy gate blocks on fixed CRITICAL/HIGH findings. Take the
# fixes, then drop back to the upstream runtime user (uid/gid 10001).
USER root
RUN set -eux; \
    apt-get update; \
    apt-get -y upgrade --no-install-recommends; \
    rm -rf /var/lib/apt/lists/*
USER prusa

COPY --from=fetch /prusa_connect /prusa_connect
