package upstream

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"fmt"
)

// KVUpstreamAccountKey is the kv-store key holding the shared upstream ACME
// account key as PKCS#8 DER. One account serves the whole homelab; its key
// is generated once and reused by every replica.
const KVUpstreamAccountKey = "upstream_account_key_pkcs8"

// KVStore is the minimal slice of the database the key vault needs. The
// Postgres implementation serializes KVSetIfAbsent under an advisory lock,
// so replicas racing at first startup converge on one key.
type KVStore interface {
	KVGet(ctx context.Context, key string) ([]byte, error)
	KVSetIfAbsent(ctx context.Context, key string, value []byte) ([]byte, error)
}

// EnsureAccountKey loads the shared upstream account key, generating and
// persisting a fresh P-256 key when none exists yet. created reports first
// generation by this caller. Callers must never log the key.
func EnsureAccountKey(ctx context.Context, kv KVStore) (key crypto.Signer, created bool, err error) {
	raw, err := kv.KVGet(ctx, KVUpstreamAccountKey)
	if err != nil {
		return nil, false, fmt.Errorf("read upstream account key: %w", err)
	}
	if raw != nil {
		k, err := parsePKCS8(raw)
		return k, false, err
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, false, fmt.Errorf("generate upstream account key: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, false, err
	}
	stored, err := kv.KVSetIfAbsent(ctx, KVUpstreamAccountKey, der)
	if err != nil {
		return nil, false, fmt.Errorf("persist upstream account key: %w", err)
	}
	k, err := parsePKCS8(stored)
	if err != nil {
		return nil, false, err
	}
	// stored may be another replica's key; created reports only our own win.
	return k, string(stored) == string(der), nil
}

func parsePKCS8(der []byte) (crypto.Signer, error) {
	k, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse stored upstream account key: %w", err)
	}
	if _, ok := k.(*ecdsa.PrivateKey); !ok {
		return nil, fmt.Errorf("unexpected stored upstream key type %T", k)
	}
	signer, ok := k.(crypto.Signer)
	if !ok {
		return nil, fmt.Errorf("stored upstream key is not a signer")
	}
	return signer, nil
}
