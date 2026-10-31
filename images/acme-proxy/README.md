# acme-proxy

An ACME server (RFC 8555) for internal machines that need real Let's
Encrypt certificates but cannot expose port 80 to the public internet.

Point standard ACME clients at `https://acme.sff.k8s.ryanb.tv/directory`
(works unmodified with certbot, acme.sh, lego, cert-manager's ACME
issuer, and Caddy's `acme_ca`). The front validates the client's own
**http-01** challenge over the **internal** network — internal DNS must
resolve the requested hostname to the client itself — then obtains a
genuine Let's Encrypt certificate upstream with **DNS-01 through
Cloudflare**, relaying the client's CSR verbatim. The client's private
key never leaves the client.

## How an issuance flows

1. Client talks normal ACME here: account, order, http-01 challenge.
2. This server fetches `http://<identifier>/.well-known/acme-challenge/<token>`
   on port 80 from inside the network and checks the key authorization.
3. On `finalize` the client's CSR is checked (SANs must equal the order
   identifiers) and issued upstream synchronously (up to 120 s, Cloudflare
   TXT propagation included); the response already carries `valid` + the
   certificate URL. A client that polls just sees one extra `processing`
   state transition.
4. The full chain comes back as `application/pem-certificate-chain`.

Renewal is normal ACME renewal: every client re-orders before expiry and
gets a fresh upstream certificate; history is kept in Postgres.

## Scope and opinionation

Single-user homelab; things are deliberately hardcoded:

- **Only http-01.** Other challenge types are absent from the directory
  and challenge objects.
- **Only `ryanb.tv` and its subdomains.** The allowlist is a compiled
  constant. Wildcards are rejected.
- **No EAB**, no account key rollover, no orders-collection endpoint.
- **One shared upstream LE account** for the whole homelab. Its P-256 key
  is generated on first startup into the `kv` table (PKCS#8 DER) under a
  Postgres advisory lock and reused by every replica.
- Revocation is accepted (account-key `kid` or certificate-key `jwk`
  auth, reason codes honored) and recorded locally. It does **not**
  propagate to Let's Encrypt; revoke at LE directly if that ever matters.

## Configuration

Exactly these environment variables; everything else is compiled in:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres DSN. Required. The sole state store. |
| `CLOUDFLARE_DNS_API_TOKEN` | Cloudflare API token. Required to issue. |
| `ACME_UPSTREAM_DIRECTORY_URL` | Upstream ACME directory. Optional; default is Let's Encrypt production. Use `https://acme-staging-v02.api.letsencrypt.org/directory` to test without rate limits. |
| `LISTEN_ADDR` | Listen address, default `:8080`. |

Plain HTTP only — TLS terminates upstream (Traefik). Absolute URLs in
responses honor `X-Forwarded-Proto` / `X-Forwarded-Host`, so route the
ingress as plain HTTP and let the proxy add the forwarded headers.

## Storage and HA

Embedded migrations run at startup under `pg_advisory_lock`, so replicas
racing to boot serialize safely. Single-use nonces live in Postgres
(`INSERT` on issue, atomic `DELETE`-if-present on consume), so any
replica can serve any request. Horizontal scaling needs nothing beyond
more replicas and one shared `DATABASE_URL`.

## Endpoints

| Path | Purpose |
| --- | --- |
| `/.well-known/acme-directory`, `/directory` | ACME directory |
| `/acme/*` | ACME protocol endpoints (JWS-authenticated) |
| `/healthz` | liveness/readiness (pings Postgres) |
| `/metrics` | Prometheus: orders, issued certificates, upstream errors/duration, certificate expiry, Go + pgx pool stats |
| `/api/v1/certificates` | JSON certificate list (no auth — internal ingress) |
| `/` | minimal HTML list of certificates, expiry color-coded |

## Client quick reference

```sh
certbot certonly --standalone --server https://acme.sff.k8s.ryanb.tv/directory -d homelab.ryanb.tv
acme.sh --issue -d homelab.ryanb.tv --webroot /srv/www --server https://acme.sff.k8s.ryanb.tv/directory
# lego: --server https://acme.sff.k8s.ryanb.tv/directory
```

cert-manager: an `ACME` `ClusterIssuer` whose `solvers` use the
`http01` solver against the ingress serving that host.

## Development

```sh
go build ./... && go vet ./...
go test ./...                        # hermetic; Postgres suite skips loudly
PG_TEST_DSN=postgres://... go test ./...   # + Postgres races, cross-replica nonces
```

## Deploy-time assumptions

- Postgres reachable from the cluster (e.g. a CNPG cluster); assemble
  `DATABASE_URL` accordingly.
- The Cloudflare token needs `Zone / DNS / Edit` on the `ryanb.tv` zone.
- Internal DNS resolves each requested hostname to the requesting host
  (that is what makes internal http-01 validation work).
- Traefik strips/sets `X-Forwarded-Proto: https` and
  `X-Forwarded-Host: acme.sff.k8s.ryanb.tv`.
- The published package must be **public** (the sff cluster pulls without
  a GHCR secret): set visibility on first publish, see the repository
  README's Package settings section.

## Let's Encrypt operational notes

- Issuance uses the production LE CA by default; rate limits apply
  (50 certificates per registered domain per week). Renewals of existing
  certificates do not count against it. Test against the staging
  directory URL first.
- The upstream account has no contact email. Set one at Let's Encrypt if
  expiry notifications are ever wanted — this service does not manage
  contact.
