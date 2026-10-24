FROM ghcr.io/actions/actions-runner:2.338.1@sha256:e275409999c37162649aa050ca573f03eab2eabcb3a1e7fcc47548de6b4f9690

ARG TARGETARCH
ARG COMPOSE_VERSION=v5.6.1
ARG COMPOSE_SHA256_X86_64=47737f4236e6d3ccea7291995203f8f018058783b4c3a9469119811a0b5db8c0
ARG COMPOSE_SHA256_AARCH64=42cfa75f51ad0ccf290bad37899e0038a8c10a0069e85233ecc1d53e3ff1347d
ARG GH_KEYRING_SHA256=6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "${GH_KEYRING_SHA256}  /etc/apt/keyrings/githubcli-archive-keyring.gpg" | sha256sum -c - \
 && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh python3 libatomic1 \
 && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      amd64) arch=x86_64; sum="${COMPOSE_SHA256_X86_64}" ;; \
      arm64) arch=aarch64; sum="${COMPOSE_SHA256_AARCH64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && install -d -m 0755 /usr/local/lib/docker/cli-plugins \
 && curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${arch}" -o /usr/local/lib/docker/cli-plugins/docker-compose \
 && echo "${sum}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c - \
 && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose

# Runner 2.338 runs JavaScript actions and its own Node work on node24.
# The node20 copies only carry npm advisories.
RUN rm -rf /home/runner/externals/node20 /home/runner/externals/node20_alpine

USER runner
