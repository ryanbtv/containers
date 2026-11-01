package upstream

import (
	"context"
	"crypto"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	legoacme "github.com/go-acme/lego/v5/acme"
	"github.com/go-acme/lego/v5/certificate"
	"github.com/go-acme/lego/v5/challenge"
	"github.com/go-acme/lego/v5/challenge/dns01"
	"github.com/go-acme/lego/v5/lego"
	"github.com/go-acme/lego/v5/providers/dns/cloudflare"
	"github.com/go-acme/lego/v5/registration"
)

// Default CA directory URLs.
const (
	DefaultCADirectoryURL = "https://acme-v02.api.letsencrypt.org/directory"
	StagingCADirectoryURL = "https://acme-staging-v02.api.letsencrypt.org/directory"
)

// DNS-01 resolver pinning (split-horizon fix).
//
// lego finds the zone to write _acme-challenge records into by walking up
// the FQDN and asking for SOA answers. By default it asks the SYSTEM
// resolver — inside this cluster that is the homelab's internal BIND,
// which answers SOA for sff.k8s.ryanb.tv because that is its own RFC2136
// zone, separate from the public ryanb.tv zone on Cloudflare. lego then
// hands the wrong zone name to the Cloudflare API and every issuance
// fails with "cloudflare: failed to find zone sff.k8s.ryanb.tv.: zone
// could not be found". Pinning lego's DNS-01 resolver (dns01.SetDefaultClient
// + Options.RecursiveNameservers) to Cloudflare's authoritative servers
// for the public zone makes the SOA walk see the public delegation. This
// mirrors cert-manager's proven --dns01-recursive-nameservers /
// --dns01-recursive-nameservers-only configuration for the same trap.
//
// In lego v5 a non-empty Options.RecursiveNameservers is itself the
// "only" switch: internal.NewClient consults /etc/resolv.conf ONLY when
// the list is empty, so once these are set the system resolver plays no
// part in DNS-01 at all.
const (
	// defaultDNS01Nameservers are Cloudflare's authoritative NS for the
	// public ryanb.tv zone (its registered delegation).
	defaultDNS01Nameservers = "adam.ns.cloudflare.com:53,betty.ns.cloudflare.com:53"

	// dns01NameserversEnv optionally overrides defaultDNS01Nameservers:
	// comma-separated host or host:port. Emergency escape hatch only; the
	// default needs no configuration.
	dns01NameserversEnv = "ACME_DNS01_NAMESERVERS"
)

// dns01Nameservers parses a comma-separated host/host:port list, defaulting
// to defaultDNS01Nameservers for blank input and filling in port 53 where
// omitted (mirrors lego's internal parseNameservers, so the unit test can
// assert the exact strings lego will dial). The result is NEVER empty: an
// empty list would make lego silently fall back to /etc/resolv.conf and
// reintroduce the split-horizon bug.
func dns01Nameservers(list string) []string {
	if strings.TrimSpace(list) == "" {
		list = defaultDNS01Nameservers
	}
	var servers []string
	for _, ns := range strings.Split(list, ",") {
		ns = strings.TrimSpace(ns)
		if ns == "" {
			continue
		}
		if _, _, err := net.SplitHostPort(ns); err != nil {
			ns = net.JoinHostPort(ns, "53")
		}
		servers = append(servers, ns)
	}
	if len(servers) == 0 {
		return dns01Nameservers("") // env was all commas/blank
	}
	return servers
}

// installDNS01Resolver replaces lego's process-wide DNS-01 DNS client.
// Every DNS-01 query lego makes — the Cloudflare provider's SOA zone walk,
// CNAME resolution, and the propagation pre-checks — goes through
// dns01.DefaultClient(), which init() had built from /etc/resolv.conf.
// Safe to call repeatedly; the swap is atomic.
func installDNS01Resolver(servers []string) {
	dns01.SetDefaultClient(dns01.NewClient(&dns01.Options{
		RecursiveNameservers: servers,
	}))
}

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
// homelab-wide upstream ACME account key from EnsureAccountKey. It also
// installs the pinned public DNS-01 resolver (see defaultDNS01Nameservers),
// once per process boot; acme-proxy's own http-01 front is unaffected —
// it resolves identifiers with the system resolver on purpose.
func NewLegoIssuer(directoryURL, cloudflareToken string, accountKey crypto.Signer) *LegoIssuer {
	if directoryURL == "" {
		directoryURL = DefaultCADirectoryURL
	}
	installDNS01Resolver(dns01Nameservers(os.Getenv(dns01NameserversEnv)))
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
// dnsCleanupProvider. Zone discovery and propagation checks use the public
// resolver pinned by NewLegoIssuer, never /etc/resolv.conf. Error strings
// may embed Let's Encrypt account or order URLs (harmless account
// metadata); no token or key material is included.
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
