# acme-proxy: an ACME server (RFC 8555) for internal machines that cannot
# expose port 80 to the public internet. Clients point certbot, acme.sh,
# lego, cert-manager, or Caddy at it; it validates their own http-01
# challenges over the internal network, then obtains a genuine Let's
# Encrypt certificate upstream using DNS-01 via Cloudflare, relaying the
# client's own CSR so private keys never leave the client.
#
# Build (the build context is this directory, as the pipeline does):
#   docker build -t acme-proxy:test images/acme-proxy
#
# Run (Postgres is the only state store; scale replicas freely):
#   docker run -p 8080:8080 -e DATABASE_URL=postgres://... \
#     -e CLOUDFLARE_DNS_API_TOKEN=... ghcr.io/ryanbtv/acme-proxy:latest
#
# No HEALTHCHECK: Kubernetes probes /healthz directly.

# renovate: datasource=docker depName=golang versioning=docker
ARG GO_VERSION=1.27-alpine

FROM golang:${GO_VERSION} AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Tests are hermetic: no network beyond loopback, and the Postgres-backed
# suite skips (loudly) without PG_TEST_DSN.
RUN go vet ./... \
 && go test ./... \
 && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/acme-proxy ./cmd/acme-proxy

# distroless-style final image: static binary + CA bundle only, so the
# Trivy gate has nothing to find.
FROM scratch

COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/acme-proxy /acme-proxy

USER 65532:65532

EXPOSE 8080

ENTRYPOINT ["/acme-proxy"]
