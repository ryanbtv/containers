# Pre-baked act runner image for Ansible playbook workflows.
#
# Slim multi-stage build from ubuntu:24.04 with only what `act` needs to run
# our self-hosted workflow: python3 + Ansible + Azure CLI + collections + git
# + ssh + node20 (for JS-based GitHub Actions). The previous base
# (ghcr.io/catthehacker/ubuntu:act-latest) ships every language toolchain a
# GitHub-hosted runner provides; the upstream cruft (pre-baked SSH host keys,
# Node toolcache npm/corepack tree, vendored yq) generated 22+ HIGH trivy
# findings that we don't actually need any of.
#
# The build context is this directory, so rebuild whenever the vendored
# requirements.{txt,yml} beside this file change:
#   docker build --platform linux/amd64 -t homelab-act:latest images/homelab-act
#
# Or pull the GHCR-published copy that the docker-build-pipeline workflow ships:
#   docker pull ghcr.io/ryanbtv/homelab-act:latest
#   docker tag  ghcr.io/ryanbtv/homelab-act:latest homelab-act:latest
#
# Then point the consuming repo's .actrc at it:
#   -P <runner-label>=homelab-act:latest
#
# The two requirements files are vendored copies of the Ansible requirements of
# the playbook repository whose act runs consume this image. They are duplicated
# rather than referenced because a build context cannot reach into another
# repository. Re-copy them when those Ansible dependencies change, or the runner
# image drifts from the playbooks it runs.

# renovate: datasource=docker depName=ubuntu versioning=ubuntu
ARG UBUNTU_VERSION=26.04

# ---- builder: pip + ansible-galaxy with toolchain ---------------------------
FROM ubuntu:${UBUNTU_VERSION} AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    HOMELAB_VENV=/opt/homelab/venv \
    ANSIBLE_COLLECTIONS_PATH=/opt/homelab/.ansible/collections

ENV PATH=${HOMELAB_VENV}/bin:${PATH}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      build-essential \
      python3 \
      python3-venv \
      python3-dev \
      libssl-dev \
      libffi-dev \
      libonig-dev \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv "${HOMELAB_VENV}" \
 && "${HOMELAB_VENV}/bin/pip" install --upgrade pip

COPY requirements.txt /tmp/requirements.txt
RUN "${HOMELAB_VENV}/bin/pip" install -r /tmp/requirements.txt azure-cli \
 && rm -f /tmp/requirements.txt

# Transitive dependencies of ansible and azure-cli that carry fixed HIGH
# advisories, which the pipeline's Trivy gate rejects:
#   setuptools   CVE-2025-47273       path traversal
#   msgpack      GHSA-6v7p-g79w-8964  out-of-bounds read
#   cryptography CVE-2026-69247/69249 PKCS#7 handling
#   urllib3      CVE-2026-97687/97689 proxy TLS override, chunk-parser DoS
#   certifi      GHSA-6q48-6c7w-9gw2  bundles compromised emSign root CAs
#   virtualenv   CVE-2026-115586      bash activator
# Upgraded here rather than in requirements.txt, so the vendored file stays a
# faithful copy of the upstream original and re-copying it stays a clean diff.
# Nothing pins these, so the upgrade resolves without conflicting with azure-cli.
RUN "${HOMELAB_VENV}/bin/pip" install --upgrade \
      "setuptools>=78.1.1" \
      "msgpack>=1.2.1" \
      "cryptography>=50.0.0" \
      "urllib3>=2.8.0" \
      "certifi>=2026.10.19" \
      "virtualenv>=21.14.13"

COPY requirements.yml /tmp/requirements.yml
RUN mkdir -p "${ANSIBLE_COLLECTIONS_PATH}" \
 && "${HOMELAB_VENV}/bin/ansible-galaxy" collection install -r /tmp/requirements.yml \
      -p "${ANSIBLE_COLLECTIONS_PATH}" \
 && rm -f /tmp/requirements.yml

# ---- runtime: minimal Ubuntu + node20 + the prebaked venv -------------------
FROM ubuntu:${UBUNTU_VERSION} AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    HOMELAB_ACT_PREBAKED=1 \
    HOMELAB_VENV=/opt/homelab/venv \
    ANSIBLE_COLLECTIONS_PATH=/opt/homelab/.ansible/collections

ENV PATH=${HOMELAB_VENV}/bin:/usr/local/node/bin:${PATH}

# Runtime-only packages. python3-venv gives us the `python3` symlink layout the
# baked venv expects; openssh-client + git are needed by actions/checkout and
# the Ansible playbook's SSH transport.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      openssh-client \
      python3 \
      python3-venv \
      tzdata \
      xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/bin/pebble

# Node 20 LTS from the official upstream tarball — `act` requires `node` on
# PATH to execute JS-based actions (actions/checkout, azure/login, ...).
# Pulling the tarball directly avoids the NodeSource apt repo, which would add
# a third-party signing key + apt source we don't otherwise need.
ARG TARGETARCH
# renovate: datasource=node-version depName=node
ARG NODE_VERSION=24.18.0
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    mkdir -p /usr/local/node; \
    tar -xJf /tmp/node.tar.xz -C /usr/local/node --strip-components=1; \
    rm -f /tmp/node.tar.xz; \
    # act only needs `node` to execute JS action `dist/index.js` files; npm +
    # corepack are never invoked from any of our workflows and their bundled
    # node_modules trees (cross-spawn, glob, minimatch, tar) drag in ~11 HIGH
    # CVEs. Purge them so trivy stays clean without a .trivyignore.
    rm -rf /usr/local/node/lib/node_modules/npm \
           /usr/local/node/lib/node_modules/corepack \
           /usr/local/node/bin/npm \
           /usr/local/node/bin/npx \
           /usr/local/node/bin/corepack; \
    /usr/local/node/bin/node --version

COPY --from=builder /opt/homelab /opt/homelab

RUN useradd -m -s /bin/bash runner

USER runner
