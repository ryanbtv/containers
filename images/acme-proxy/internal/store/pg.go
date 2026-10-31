// Package store is the Postgres-backed state of acme-proxy: accounts,
// orders, authorizations, certificates, single-use nonces, and shared
// key-value state. Everything the handlers need is reachable through one
// pool, so any replica can serve any request.
package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ryanbtv/containers/images/acme-proxy/internal/acme"
)

// nonceTTL is how long an issued nonce stays consumable.
const nonceTTL = 120 * time.Second

// DB implements acme.Store on Postgres.
type DB struct {
	pool *pgxpool.Pool
}

var _ acme.Store = (*DB)(nil)

// New opens a pool from a Postgres DSN and verifies connectivity.
func New(ctx context.Context, dsn string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	db := &DB{pool: pool}
	return db, nil
}

// Pool exposes the underlying pool for the stats collector and key vaulting.
func (db *DB) Pool() *pgxpool.Pool { return db.pool }

// Close releases the pool.
func (db *DB) Close() { db.pool.Close() }

// Ping satisfies the readiness probe.
func (db *DB) Ping(ctx context.Context) error { return db.pool.Ping(ctx) }

// ---- nonces ----

func (db *DB) NewNonce(ctx context.Context) (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	nonce := base64.RawURLEncoding.EncodeToString(buf)
	// One INSERT per issued nonce; expired rows are pruned lazily here so no
	// background job is needed.
	_, err := db.pool.Exec(ctx, `
		WITH prune AS (DELETE FROM acme_nonces WHERE issued_at < now() - make_interval(secs => $2))
		INSERT INTO acme_nonces(nonce) VALUES ($1)`, nonce, nonceTTL.Seconds())
	if err != nil {
		return "", err
	}
	return nonce, nil
}

// ConsumeNonce deletes the nonce if present and unexpired. The DELETE is the
// atomic single-use guarantee across replicas: exactly one caller can delete
// a given row.
func (db *DB) ConsumeNonce(ctx context.Context, nonce string) (bool, error) {
	tag, err := db.pool.Exec(ctx, `
		DELETE FROM acme_nonces
		WHERE nonce = $1 AND issued_at > now() - make_interval(secs => $2)`,
		nonce, nonceTTL.Seconds())
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ---- accounts ----

func scanAccount(row pgx.Row) (acme.Account, error) {
	var (
		a       acme.Account
		jwk     []byte
		contact []byte
	)
	err := row.Scan(&a.ID, &jwk, &a.Thumbprint, &a.Status, &contact, &a.CreatedAt)
	if err != nil {
		return acme.Account{}, err
	}
	a.JWK = json.RawMessage(jwk)
	if len(contact) > 0 {
		if err := json.Unmarshal(contact, &a.Contact); err != nil {
			return acme.Account{}, fmt.Errorf("account contact json: %w", err)
		}
	}
	return a, nil
}

const accountColumns = "id, jwk, thumbprint, status, contact, created_at"

func (db *DB) CreateAccount(ctx context.Context, jwk json.RawMessage, thumbprint string, contact []string) (acme.Account, bool, error) {
	if contact == nil {
		contact = []string{}
	}
	cJSON, err := json.Marshal(contact)
	if err != nil {
		return acme.Account{}, false, err
	}
	var id int64
	err = db.pool.QueryRow(ctx, `
		INSERT INTO acme_accounts(jwk, thumbprint, contact)
		VALUES ($1::jsonb, $2, $3::jsonb)
		ON CONFLICT (thumbprint) DO NOTHING
		RETURNING id`, string(jwk), thumbprint, string(cJSON)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		acc, _, lerr := db.AccountByThumbprint(ctx, thumbprint)
		return acc, false, lerr
	}
	if err != nil {
		return acme.Account{}, false, err
	}
	acc, _, err := db.AccountByID(ctx, id)
	return acc, true, err
}

func (db *DB) AccountByThumbprint(ctx context.Context, thumbprint string) (acme.Account, bool, error) {
	acc, err := scanAccount(db.pool.QueryRow(ctx,
		"SELECT "+accountColumns+" FROM acme_accounts WHERE thumbprint=$1", thumbprint))
	if errors.Is(err, pgx.ErrNoRows) {
		return acme.Account{}, false, nil
	}
	return acc, err == nil, err
}

func (db *DB) AccountByID(ctx context.Context, id int64) (acme.Account, bool, error) {
	acc, err := scanAccount(db.pool.QueryRow(ctx,
		"SELECT "+accountColumns+" FROM acme_accounts WHERE id=$1", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return acme.Account{}, false, nil
	}
	return acc, err == nil, err
}

func (db *DB) SetAccountStatus(ctx context.Context, id int64, status string) (acme.Account, error) {
	acc, err := scanAccount(db.pool.QueryRow(ctx,
		"UPDATE acme_accounts SET status=$2 WHERE id=$1 RETURNING "+accountColumns, id, status))
	return acc, err
}

func (db *DB) SetAccountContact(ctx context.Context, id int64, contact []string) (acme.Account, error) {
	if contact == nil {
		contact = []string{}
	}
	cJSON, err := json.Marshal(contact)
	if err != nil {
		return acme.Account{}, err
	}
	acc, err := scanAccount(db.pool.QueryRow(ctx,
		"UPDATE acme_accounts SET contact=$2::jsonb WHERE id=$1 RETURNING "+accountColumns, id, string(cJSON)))
	return acc, err
}

// ---- orders & authorizations ----

func scanOrder(row pgx.Row) (acme.Order, error) {
	var (
		o       acme.Order
		ids     []byte
		errJSON []byte
		certID  *int64
	)
	err := row.Scan(&o.ID, &o.AccountID, &ids, &o.Status, &errJSON, &certID, &o.ExpiresAt, &o.CreatedAt)
	if err != nil {
		return acme.Order{}, err
	}
	if err := json.Unmarshal(ids, &o.Identifiers); err != nil {
		return acme.Order{}, fmt.Errorf("order identifiers json: %w", err)
	}
	if len(errJSON) > 0 {
		o.Error = json.RawMessage(errJSON)
	}
	if certID != nil {
		o.CertificateID = *certID
	}
	return o, nil
}

const orderColumns = "id, account_id, identifiers, status, error, certificate_id, expires_at, created_at"

func (db *DB) CreateOrder(ctx context.Context, accountID int64, identifiers []string) (acme.Order, []acme.Authz, error) {
	idJSON, err := json.Marshal(identifiers)
	if err != nil {
		return acme.Order{}, nil, err
	}
	var out []acme.Authz
	var order acme.Order
	err = pgx.BeginFunc(ctx, db.pool, func(tx pgx.Tx) error {
		order, err = scanOrder(tx.QueryRow(ctx, `
			INSERT INTO acme_orders(account_id, identifiers)
			VALUES ($1, $2::jsonb) RETURNING `+orderColumns, accountID, string(idJSON)))
		if err != nil {
			return err
		}
		for _, id := range identifiers {
			token, err := newToken()
			if err != nil {
				return err
			}
			var a acme.Authz
			if err := tx.QueryRow(ctx, `
				INSERT INTO acme_authorizations(order_id, identifier, token)
				VALUES ($1, $2, $3)
				RETURNING id, order_id, identifier, token, status, created_at`,
				order.ID, id, token).
				Scan(&a.ID, &a.OrderID, &a.Identifier, &a.Token, &a.Status, &a.CreatedAt); err != nil {
				return err
			}
			out = append(out, a)
		}
		return nil
	})
	if err != nil {
		return acme.Order{}, nil, err
	}
	return order, out, nil
}

func newToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	// base64url without padding, per RFC 8555 §8.3 token alphabet.
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func (db *DB) OrderByID(ctx context.Context, id int64) (acme.Order, bool, error) {
	o, err := scanOrder(db.pool.QueryRow(ctx,
		"SELECT "+orderColumns+" FROM acme_orders WHERE id=$1", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return acme.Order{}, false, nil
	}
	return o, err == nil, err
}

func scanAuthz(row pgx.Row) (acme.Authz, error) {
	var (
		a       acme.Authz
		errJSON []byte
	)
	err := row.Scan(&a.ID, &a.OrderID, &a.Identifier, &a.Token, &a.Status, &errJSON, &a.CreatedAt, &a.ValidatedAt)
	if len(errJSON) > 0 {
		a.Error = json.RawMessage(errJSON)
	}
	return a, err
}

const authzColumns = "id, order_id, identifier, token, status, error, created_at, validated_at"

func (db *DB) AuthzByOrder(ctx context.Context, orderID int64) ([]acme.Authz, error) {
	rows, err := db.pool.Query(ctx,
		"SELECT "+authzColumns+" FROM acme_authorizations WHERE order_id=$1 ORDER BY id", orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []acme.Authz
	for rows.Next() {
		a, err := scanAuthz(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (db *DB) AuthzByID(ctx context.Context, id int64) (acme.Authz, bool, error) {
	a, err := scanAuthz(db.pool.QueryRow(ctx,
		"SELECT "+authzColumns+" FROM acme_authorizations WHERE id=$1", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return acme.Authz{}, false, nil
	}
	return a, err == nil, err
}

// CompleteValidation records the challenge result and recomputes the order
// status under a row lock on the order.
func (db *DB) CompleteValidation(ctx context.Context, authzID int64, valid bool, problem *acme.Problem) (acme.Authz, error) {
	var result acme.Authz
	err := pgx.BeginFunc(ctx, db.pool, func(tx pgx.Tx) error {
		var orderID int64
		var orderStatus string
		if err := tx.QueryRow(ctx, `
			SELECT o.id, o.status
			FROM acme_authorizations a JOIN acme_orders o ON o.id = a.order_id
			WHERE a.id = $1
			FOR UPDATE OF o`, authzID).Scan(&orderID, &orderStatus); err != nil {
			return err
		}

		status := "valid"
		if !valid {
			status = "invalid"
		}
		var errJSON []byte
		if problem != nil {
			errJSON, _ = json.Marshal(problem)
		}
		a, err := scanAuthz(tx.QueryRow(ctx, `
			UPDATE acme_authorizations
			SET status=$2, error=$3::jsonb, validated_at=now()
			WHERE id=$1 RETURNING `+authzColumns, authzID, status, nullableJSON(errJSON)))
		if err != nil {
			return err
		}
		result = a

		if orderStatus != "pending" {
			return nil // order already advanced; do not regress it
		}
		if !valid {
			if _, err := tx.Exec(ctx,
				"UPDATE acme_orders SET status='invalid', error=$2::jsonb, updated_at=now() WHERE id=$1",
				orderID, string(errJSON)); err != nil {
				return err
			}
			return nil
		}
		var remaining int
		if err := tx.QueryRow(ctx,
			"SELECT count(*) FROM acme_authorizations WHERE order_id=$1 AND status <> 'valid'",
			orderID).Scan(&remaining); err != nil {
			return err
		}
		if remaining == 0 {
			if _, err := tx.Exec(ctx,
				"UPDATE acme_orders SET status='ready', updated_at=now() WHERE id=$1", orderID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return acme.Authz{}, err
	}
	return result, nil
}

// SetOrderProcessing transitions ready → processing atomically. The status
// predicate in the WHERE clause is the mutual exclusion that stops two
// concurrent finalize POSTs (same replica or different ones) from both
// calling the upstream issuer: exactly one UPDATE matches a 'ready' row.
func (db *DB) SetOrderProcessing(ctx context.Context, orderID int64) (bool, error) {
	tag, err := db.pool.Exec(ctx,
		"UPDATE acme_orders SET status='processing', updated_at=now() WHERE id=$1 AND status='ready'", orderID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (db *DB) CompleteOrder(ctx context.Context, orderID, certificateID int64) (acme.Order, error) {
	o, err := scanOrder(db.pool.QueryRow(ctx, `
		UPDATE acme_orders
		SET status='valid', certificate_id=$2, error=NULL, updated_at=now()
		WHERE id=$1 RETURNING `+orderColumns, orderID, certificateID))
	return o, err
}

func (db *DB) FailOrder(ctx context.Context, orderID int64, problem *acme.Problem) (acme.Order, error) {
	errJSON, _ := json.Marshal(problem)
	o, err := scanOrder(db.pool.QueryRow(ctx, `
		UPDATE acme_orders
		SET status='invalid', error=$2::jsonb, updated_at=now()
		WHERE id=$1 RETURNING `+orderColumns, orderID, string(errJSON)))
	return o, err
}

// ---- certificates ----

func (db *DB) SaveCertificate(ctx context.Context, accountID, orderID int64, rec acme.CertRecord) (int64, error) {
	sans, err := json.Marshal(rec.Sans)
	if err != nil {
		return 0, err
	}
	var id int64
	err = db.pool.QueryRow(ctx, `
		INSERT INTO acme_certificates(serial, aki, der, chain_pem, common_name, sans,
		                                      account_id, order_id, not_before, not_after)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
		RETURNING id`,
		rec.Serial, rec.AKI, rec.DER, string(rec.ChainPEM), rec.CommonName, string(sans),
		accountID, orderID, rec.NotBefore, rec.NotAfter).Scan(&id)
	return id, err
}

func scanCert(row pgx.Row) (acme.CertRecord, int64, error) {
	var (
		rec       acme.CertRecord
		accountID int64
		chain     string
		sans      []byte
	)
	err := row.Scan(&rec.Serial, &rec.AKI, &rec.DER, &chain, &rec.CommonName, &sans,
		&accountID, &rec.NotBefore, &rec.NotAfter)
	if err != nil {
		return acme.CertRecord{}, 0, err
	}
	rec.ChainPEM = []byte(chain)
	if err := json.Unmarshal(sans, &rec.Sans); err != nil {
		return acme.CertRecord{}, 0, err
	}
	return rec, accountID, nil
}

const certColumns = "serial, aki, der, chain_pem, common_name, sans, account_id, not_before, not_after"

func (db *DB) CertificateByID(ctx context.Context, id int64) (acme.CertRecord, int64, bool, error) {
	rec, acc, err := scanCert(db.pool.QueryRow(ctx,
		"SELECT "+certColumns+" FROM acme_certificates WHERE id=$1", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return acme.CertRecord{}, 0, false, nil
	}
	return rec, acc, err == nil, err
}

func (db *DB) CertificateBySerial(ctx context.Context, serial, aki string) (acme.CertRecord, int64, bool, error) {
	rec, acc, err := scanCert(db.pool.QueryRow(ctx,
		"SELECT "+certColumns+" FROM acme_certificates WHERE serial=$1 AND ($2='' OR aki=$2)", serial, aki))
	if errors.Is(err, pgx.ErrNoRows) {
		return acme.CertRecord{}, 0, false, nil
	}
	return rec, acc, err == nil, err
}

func (db *DB) RevokeCertificate(ctx context.Context, serial, aki string, reason int) (acme.CertRecord, int64, bool, bool, error) {
	var (
		rec     acme.CertRecord
		id      int64
		acc     int64
		revoked bool
	)
	err := pgx.BeginFunc(ctx, db.pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT id, account_id, revoked_at IS NOT NULL, serial, common_name
			FROM acme_certificates
			WHERE serial = $1 AND ($2 = '' OR aki = $2)
			FOR UPDATE`, serial, aki).Scan(&id, &acc, &revoked, &rec.Serial, &rec.CommonName); err != nil {
			return err
		}
		if revoked {
			return nil
		}
		_, err := tx.Exec(ctx,
			"UPDATE acme_certificates SET revoked_at = now(), revoke_reason = $2 WHERE id = $1",
			id, reason)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return acme.CertRecord{}, 0, false, false, nil
	}
	if err != nil {
		return acme.CertRecord{}, 0, false, false, err
	}
	return rec, acc, true, revoked, nil
}

func (db *DB) ListCertificates(ctx context.Context) ([]acme.CertSummary, error) {
	rows, err := db.pool.Query(ctx, `
		SELECT c.serial, c.aki, c.common_name, c.sans::text, c.issued_at,
		       c.not_before, c.not_after, c.revoked_at, c.revoke_reason,
		       COALESCE(a.thumbprint, '')
		FROM acme_certificates c
		LEFT JOIN acme_accounts a ON a.id = c.account_id
		ORDER BY c.issued_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []acme.CertSummary
	for rows.Next() {
		var (
			s      acme.CertSummary
			sans   string
			revAt  *time.Time
			revWhy *int
		)
		if err := rows.Scan(&s.Serial, &s.AKI, &s.CommonName, &sans, &s.IssuedAt,
			&s.NotBefore, &s.NotAfter, &revAt, &revWhy, &s.AccountThumbprint); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(sans), &s.Sans); err != nil {
			return nil, err
		}
		s.Revoked = revAt != nil
		s.RevokedAt = revAt
		s.RevokeReason = revWhy
		out = append(out, s)
	}
	return out, rows.Err()
}

// ---- shared key-value state ----

// kvLockKey serializes first-write races (the upstream LE account key).
const kvLockKey = 777_001_002

// KVGet returns nil when the key is absent.
func (db *DB) KVGet(ctx context.Context, key string) ([]byte, error) {
	var val []byte
	err := db.pool.QueryRow(ctx, "SELECT value FROM kv WHERE key=$1", key).Scan(&val)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return val, err
}

// KVSetIfAbsent stores value unless the key already exists, under an
// advisory transaction lock so racing replicas converge on one winner.
// It returns the stored value, whichever it is: the new one or the winner's.
func (db *DB) KVSetIfAbsent(ctx context.Context, key string, value []byte) ([]byte, error) {
	var winner []byte
	err := pgx.BeginFunc(ctx, db.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", kvLockKey); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, "SELECT value FROM kv WHERE key=$1", key).Scan(&winner); err == nil {
			return nil // already present: existing value wins
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if _, err := tx.Exec(ctx,
			"INSERT INTO kv(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", key, value); err != nil {
			return err
		}
		winner = value
		return nil
	})
	if err != nil {
		return nil, err
	}
	return winner, nil
}

func nullableJSON(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}
