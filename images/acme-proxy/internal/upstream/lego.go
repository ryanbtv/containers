package upstream

import (
	"context"
	"crypto"
	"crypto/x509"
	"errors"
	"fmt"
	"time"

	legoacme "github.com/go-acme/lego/v5/acme"
	"github.com/go-acme/lego/v5/certificate"
	"github.com/go-acme/lego/v5/challenge"
	"github.com/go-acme/lego/v5/lego"
	"github.com/go-acme/lego/v5/providers/dns/cloudflare"
	"github.com/go-acme/lego/v5/registration"
)

// Default CA directory URLs.
const (
	DefaultCADirectoryURL = "https://acme-v02.api.letsencrypt.org/directory"
	StagingCADirectoryURL = "https://acme-staging-v02.api.letsencrypt.org/directory"
)

// LegoIssuer is the production Issuer: it solves DNS-01 at Cloudflare and
// passes the client's CSR verbatim to the upstream ACME CA, so the client's
// private key never leaves the client.
type LegoIssuer struct {
	directoryURL string
	cfToken      string
	accountKey   crypto.Signer
	userAgent    string
}

var _ Issuer = (*LegoIssuer)(nil)

// NewLegoIssuer wires the upstream client. accountKey is the shared
// homelab-wide upstream ACME account key from EnsureAccountKey.
func NewLegoIssuer(directoryURL, cloudflareToken string, accountKey crypto.Signer) *LegoIssuer {
	if directoryURL == "" {
		directoryURL = DefaultCADirectoryURL
	}
	return &LegoIssuer{
		directoryURL: directoryURL,
		cfToken:      cloudflareToken,
		accountKey:   accountKey,
		userAgent:    "acme-proxy/1.0 (+https://acme.sff.k8s.ryanb.tv)",
	}
}

// leAccount adapts our shared key to lego's registration.User. The upstream
// account has no contact email on purpose.
type leAccount struct{ key crypto.Signer }

func (a *leAccount) GetEmail() string                           { return "" }
func (a *leAccount) GetRegistration() *legoacme.ExtendedAccount { return nil }
func (a *leAccount) GetPrivateKey() crypto.Signer               { return a.key }

// cleanupGrace bounds the detached TXT-record cleanup.
const cleanupGrace = 30 * time.Second

// dnsCleanupProvider wraps a DNS provider so TXT-record cleanup survives
// cancellation of the issuance context (deadline exceeded or client
// disconnect mid-finalize). lego hands the caller's ctx verbatim to
// CleanUp (challenge/resolver/prober.go cleanUp), so with a canceled
// context the Cloudflare DELETE would fail and leave stale
// _acme-challenge TXT records behind. Cleanup instead gets a fresh,
// bounded context detached from the caller's.
type dnsCleanupProvider struct {
	challenge.ProviderTimeout
}

func (p dnsCleanupProvider) CleanUp(ctx context.Context, domain, token, keyAuth string) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupGrace)
	defer cancel()
	return p.ProviderTimeout.CleanUp(cleanupCtx, domain, token, keyAuth)
}

// Issue runs one upstream issuance. The caller bounds ctx (~120s), which
// caps lego's DNS-01 propagation wait too: Cloudflare's propagation wait is
// configured below to fit inside that budget. TXT cleanup runs on success
// AND every failure path, including ctx cancellation, via
// dnsCleanupProvider. Error strings may embed Let's Encrypt account or
// order URLs (harmless account metadata); no token or key material is
// included.
func (l *LegoIssuer) Issue(ctx context.Context, csrDER []byte, identifiers []string) ([]byte, error) {
	if l.cfToken == "" {
		return nil, errors.New("upstream issuance unavailable: CLOUDFLARE_DNS_API_TOKEN is not configured")
	}
	csr, err := x509.ParseCertificateRequest(csrDER)
	if err != nil {
		return nil, fmt.Errorf("reparse CSR for issuance: %w", err)
	}

	cfg := lego.NewConfig(&leAccount{key: l.accountKey})
	cfg.CADirURL = l.directoryURL
	cfg.UserAgent = l.userAgent

	client, err := lego.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("lego client: %w", err)
	}

	cfCfg := cloudflare.NewDefaultConfig()
	cfCfg.AuthToken = l.cfToken
	// Cloudflare's default propagation wait (120 s) equals the whole
	// issuance budget; cap it so upstream validation, finalize, and chain
	// download still fit inside the caller's ~120 s deadline instead of
	// being cut off mid-flight with a stale TXT record pending.
	cfCfg.PropagationTimeout = 90 * time.Second
	provider, err := cloudflare.NewDNSProviderConfig(cfCfg)
	if err != nil {
		return nil, fmt.Errorf("cloudflare dns provider: %w", err)
	}
	if err := client.Challenge.SetDNS01Provider(dnsCleanupProvider{provider}); err != nil {
		return nil, fmt.Errorf("dns01 solver: %w", err)
	}

	// newAccount with an existing key returns the existing account, so this
	// is idempotent and keeps every replica on the one shared account.
	if _, err := client.Registration.Register(ctx, registration.RegisterOptions{
		TermsOfServiceAgreed: true,
	}); err != nil {
		return nil, fmt.Errorf("upstream account: %w", err)
	}

	res, err := client.Certificate.ObtainForCSR(ctx, certificate.ObtainForCSRRequest{
		CSR:    csr,
		Bundle: true,
	})
	if err != nil {
		return nil, fmt.Errorf("upstream obtain for %v: %w", identifiers, err)
	}
	return res.Certificate, nil
}
