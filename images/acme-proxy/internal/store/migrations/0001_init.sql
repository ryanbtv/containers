-- acme-proxy initial schema. Applied once at startup under a Postgres
-- advisory lock, so racing replicas serialize.

CREATE TABLE acme_accounts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    jwk         JSONB NOT NULL,
    thumbprint  TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'valid',
    contact     JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE acme_orders (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id     BIGINT NOT NULL REFERENCES acme_accounts(id),
    identifiers    JSONB NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    error          JSONB,
    certificate_id BIGINT,
    expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE acme_authorizations (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id     BIGINT NOT NULL REFERENCES acme_orders(id) ON DELETE CASCADE,
    identifier   TEXT NOT NULL,
    token        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    error        JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    validated_at TIMESTAMPTZ
);

CREATE INDEX acme_authorizations_order_idx ON acme_authorizations (order_id);

CREATE TABLE acme_certificates (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    serial        TEXT NOT NULL UNIQUE,
    aki           TEXT NOT NULL DEFAULT '',
    der           BYTEA NOT NULL,
    chain_pem     TEXT NOT NULL,
    common_name   TEXT NOT NULL DEFAULT '',
    sans          JSONB NOT NULL,
    account_id    BIGINT REFERENCES acme_accounts(id),
    order_id      BIGINT REFERENCES acme_orders(id),
    issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    not_before    TIMESTAMPTZ NOT NULL,
    not_after     TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    revoke_reason INT
);

ALTER TABLE acme_orders
    ADD CONSTRAINT acme_orders_certificate_fkey
    FOREIGN KEY (certificate_id) REFERENCES acme_certificates(id);

CREATE TABLE acme_nonces (
    nonce     TEXT PRIMARY KEY,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX acme_nonces_issued_idx ON acme_nonces (issued_at);

-- Shared key-value state; holds the single upstream Let's Encrypt account
-- key (PKCS#8 DER) under the key 'upstream_account_key_pkcs8'.
CREATE TABLE kv (
    key        TEXT PRIMARY KEY,
    value      BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
