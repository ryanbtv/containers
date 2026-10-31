// Package acme implements the minimal RFC 8555 ACME server subset that
// acme-proxy needs: an http-01-only front that validates challenges on the
// internal network and relays issuance to an upstream ACME CA.
package acme

import (
	"context"
	"encoding/json"
	"time"
)

// Account is a stored ACME account (RFC 8555 §7.1).
type Account struct {
	ID         int64
	JWK        json.RawMessage // public JWK, canonicalized
	Thumbprint string          // RFC 7638 SHA-256 thumbprint, base64url
	Status     string          // valid | deactivated | revoked
	Contact    []string
	CreatedAt  time.Time
}

// Order is a stored ACME order (RFC 8555 §7.1.3).
type Order struct {
	ID            int64
	AccountID     int64
	Identifiers   []string // DNS names, lowercased
	Status        string   // pending | ready | processing | valid | invalid
	Error         json.RawMessage
	CertificateID int64 // 0 when no certificate yet
	ExpiresAt     time.Time
	CreatedAt     time.Time
}

// Authz is a stored authorization carrying the single http-01 challenge.
// acme-proxy supports exactly one challenge type, so the challenge state
// lives on the authorization row; its URL ends in challenge id "1".
type Authz struct {
	ID          int64
	OrderID     int64
	Identifier  string
	Token       string
	Status      string // pending | valid | invalid
	Error       json.RawMessage
	CreatedAt   time.Time
	ValidatedAt *time.Time
}

// CertRecord is the full stored record of an issued certificate.
type CertRecord struct {
	Serial     string // uppercase hex
	AKI        string // hex authority key identifier of the issuer
	CommonName string
	DER        []byte
	ChainPEM   []byte
	Sans       []string
	NotBefore  time.Time
	NotAfter   time.Time
}

// CertSummary powers the JSON API, the HTML page, and the expiry gauge.
type CertSummary struct {
	Serial            string
	AKI               string
	CommonName        string
	Sans              []string
	IssuedAt          time.Time
	NotBefore         time.Time
	NotAfter          time.Time
	Revoked           bool
	RevokedAt         *time.Time
	RevokeReason      *int
	AccountThumbprint string
}

// Store is the Postgres-backed state every handler needs. Every method must
// be safe to call concurrently from multiple replicas.
type Store interface {
	// NewNonce issues a single-use nonce. ConsumeNonce deletes it, so any
	// replica can consume a nonce issued by any other replica.
	NewNonce(ctx context.Context) (string, error)
	ConsumeNonce(ctx context.Context, nonce string) (bool, error)

	// CreateAccount inserts or returns the account for thumbprint.
	// created reports whether a new row was inserted.
	CreateAccount(ctx context.Context, jwk json.RawMessage, thumbprint string, contact []string) (acc Account, created bool, err error)
	AccountByThumbprint(ctx context.Context, thumbprint string) (Account, bool, error)
	AccountByID(ctx context.Context, id int64) (Account, bool, error)
	SetAccountStatus(ctx context.Context, id int64, status string) (Account, error)
	SetAccountContact(ctx context.Context, id int64, contact []string) (Account, error)

	// CreateOrder inserts the order and one pending authorization per
	// identifier in one transaction.
	CreateOrder(ctx context.Context, accountID int64, identifiers []string) (Order, []Authz, error)
	OrderByID(ctx context.Context, id int64) (Order, bool, error)
	AuthzByOrder(ctx context.Context, orderID int64) ([]Authz, error)
	AuthzByID(ctx context.Context, id int64) (Authz, bool, error)

	// CompleteValidation records a validation result and recomputes the
	// parent order status in one transaction: an invalid authorization
	// invalidates the order; all-valid advances pending to ready. Orders
	// already past pending (processing, valid) keep their status.
	CompleteValidation(ctx context.Context, authzID int64, valid bool, problem *Problem) (Authz, error)
	// SetOrderProcessing atomically transitions ready → processing, so
	// racing finalize requests cannot both reach the upstream issuer. It
	// reports whether this caller made the transition.
	SetOrderProcessing(ctx context.Context, orderID int64) (bool, error)
	CompleteOrder(ctx context.Context, orderID, certificateID int64) (Order, error)
	FailOrder(ctx context.Context, orderID int64, problem *Problem) (Order, error)

	// SaveCertificate returns the new certificate row id.
	SaveCertificate(ctx context.Context, accountID, orderID int64, rec CertRecord) (int64, error)
	CertificateByID(ctx context.Context, id int64) (CertRecord, int64, bool, error)
	CertificateBySerial(ctx context.Context, serial, aki string) (CertRecord, int64, bool, error)
	// RevokeCertificate marks revoked. found=false when the serial (and
	// AKI, when non-empty) matches no certificate; revokedAlready=true when
	// it was already revoked.
	RevokeCertificate(ctx context.Context, serial, aki string, reason int) (rec CertRecord, accountID int64, found, revokedAlready bool, err error)
	ListCertificates(ctx context.Context) ([]CertSummary, error)
}
