# NetBox MCP server: a zero-dependency Node.js MCP server for NetBox's REST
# and GraphQL APIs. stdio by default; optional streamable HTTP for hosting.
#
# Build (the build context is this directory, as the pipeline does):
#   docker build -t netbox-mcp:test images/netbox-mcp
#
# Run over stdio (the token passes from the environment, never argv):
#   docker run -i --rm --init -e NETBOX_URL=https://netbox.example -e NETBOX_TOKEN \
#     ghcr.io/ryanbtv/netbox-mcp:latest
#
# No HEALTHCHECK: the default stdio mode has no port to probe, and a check that
# always passes would only hide failures. HTTP mode serves GET /health for a
# Kubernetes probe instead. See README.md.

# renovate: datasource=docker depName=node versioning=docker
ARG NODE_VERSION=26.7.0-alpine3.24

FROM node:${NODE_VERSION}

# The server uses only Node built-ins. npm's bundled node_modules tree carries
# HIGH CVEs that would fail the pipeline's Trivy gate, and nothing here runs it.
# The upgrade picks up Alpine fixes published after the base image was cut.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /opt/yarn-* \
           /usr/local/bin/yarn \
           /usr/local/bin/yarnpkg \
 && adduser -D -H -u 10001 -s /sbin/nologin mcp

WORKDIR /app

# The build context is this directory, so these are directory-relative.
COPY VERSION catalog.json server.mjs /app/
COPY src/ /app/src/
COPY scripts/ /app/scripts/
COPY test/ /app/test/

# Tests run against an in-process fake NetBox; no network is needed. The test
# files and the host-side catalog generator do not ship in the final layer.
RUN node --test test/*.test.mjs \
 && rm -rf /app/test /app/scripts

ENV NODE_ENV=production

USER 10001

ENTRYPOINT ["node", "/app/server.mjs"]
