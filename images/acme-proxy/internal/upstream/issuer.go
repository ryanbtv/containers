// Package upstream obtains genuine certificates from an upstream ACME CA
// (Let's Encrypt) using DNS-01 via Cloudflare, carrying the client's own CSR
// verbatim so the client's private key never leaves the client.
package upstream

import "context"

// Issuer obtains a full certificate chain for a client CSR.
type Issuer interface {
	Issue(ctx context.Context, csrDER []byte, identifiers []string) (chainPEM []byte, err error)
}
