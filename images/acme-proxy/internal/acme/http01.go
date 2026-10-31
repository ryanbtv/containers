package acme

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// HTTP01PathPrefix is the RFC 8555 §8.3 challenge path.
const HTTP01PathPrefix = "/.well-known/acme-challenge/"

// KeyAuthorization returns token + "." + base64url(SHA-256(account key JWK)).
func KeyAuthorization(token, accountKeyThumbprint string) string {
	return token + "." + accountKeyThumbprint
}

// HTTP01Validator fetches the challenge resource over the internal network.
// Per spec the URL is plain http on port 80 with no a priori knowledge of
// the port; internal DNS resolves client hostnames to internal addresses.
//
// DialContext is injectable so integration tests can point a test hostname
// at an in-process listener.
type HTTP01Validator struct {
	DialContext func(ctx context.Context, network, addr string) (net.Conn, error)
	Timeout     time.Duration // per-validation deadline, default 30s
}

// maxRedirects bounds http-01 redirect following (RFC 8555 §8.3).
const maxRedirects = 10

// errRedirectRefused marks a redirect rejected by the CheckRedirect policy
// below, so Validate can classify it separately from transport failures.
var errRedirectRefused = errors.New("redirect refused")

// Validate fetches the token URL and compares the body with keyAuth.
// Redirects are followed per RFC 8555 §8.3, bounded like Boulder: the
// target must stay on the identifier's own hostname and on port 80 (http)
// or 443 (https). Without that check a compromised host answering for an
// allowlisted name could redirect the validator at arbitrary internal
// addresses (SSRF). It returns nil on success or an ACME problem suitable
// for the authorization error object.
func (v *HTTP01Validator) Validate(ctx context.Context, domain, token, keyAuth string) *Problem {
	timeout := v.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dial := v.DialContext
	if dial == nil {
		d := &net.Dialer{Timeout: 10 * time.Second}
		dial = d.DialContext
	}
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("too many redirects (%d): %w", maxRedirects, errRedirectRefused)
			}
			u := req.URL
			host := strings.ToLower(u.Hostname())
			if host != strings.ToLower(domain) {
				return fmt.Errorf("redirect to %q refused: target host must equal the identifier host %q: %w",
					u.Host, domain, errRedirectRefused)
			}
			switch {
			case strings.EqualFold(u.Scheme, "http") && (u.Port() == "" || u.Port() == "80"):
			case strings.EqualFold(u.Scheme, "https") && (u.Port() == "" || u.Port() == "443"):
			default:
				return fmt.Errorf("redirect to %s://%s refused: only ports 80 and 443 are allowed: %w",
					u.Scheme, u.Host, errRedirectRefused)
			}
			return nil
		},
		Transport: &http.Transport{
			DialContext: dial,
			// Port 80 only, per spec. No TLS: the URL scheme is http.
			DisableKeepAlives: true,
			// A same-host https: redirect cannot present a trusted chain:
			// the host is proving it controls the name precisely because
			// it has no valid certificate yet (Boulder skips verification
			// for validation fetches too). Authenticity comes from the
			// key authorization body, not from TLS.
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // validation traffic; content authenticated by key authorization
		},
	}

	target := "http://" + domain + HTTP01PathPrefix + token
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return newProblem(problemMalformed, "cannot build validation request: "+err.Error(), http.StatusBadRequest)
	}
	req.Header.Set("User-Agent", "acme-proxy-http01/1.0")

	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, errRedirectRefused) {
			// The refusal text describes the rejected target, never the
			// token or key authorization.
			return newProblem(problemConnection, "http-01 redirect refused: "+err.Error(), http.StatusForbidden)
		}
		return classifyFetchError(err, domain)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4097))
	if err != nil {
		return classifyFetchError(err, domain)
	}
	if len(body) > 4096 {
		return newProblem(problemUnauthorized, "challenge response body too large", http.StatusForbidden)
	}
	if resp.StatusCode != http.StatusOK {
		return newProblem(problemUnauthorized,
			"invalid response from "+target+": HTTP "+strconv.Itoa(resp.StatusCode), http.StatusForbidden)
	}
	got := strings.TrimRight(string(body), "\r\n")
	if got != keyAuth {
		return newProblem(problemUnauthorized,
			"incorrect key authorization response from "+target, http.StatusForbidden)
	}
	return nil
}

// classifyFetchError maps transport failures to ACME error URNs per
// RFC 8555 §6.7 (connection, dns, tls, unknownHost).
func classifyFetchError(err error, domain string) *Problem {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		if dnsErr.IsNotFound {
			return newProblem(problemUnknownHost, "no DNS entry for "+domain+": "+dnsErr.Error(), http.StatusForbidden)
		}
		return newProblem("dns", "DNS resolution failed for "+domain+": "+dnsErr.Error(), http.StatusForbidden)
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		if ne, ok := urlErr.Err.(net.Error); ok && ne.Timeout() {
			return newProblem(problemConnection, "timeout fetching "+domain+": "+urlErr.Error(), http.StatusForbidden)
		}
		return newProblem(problemConnection, "connection error fetching "+domain+": "+urlErr.Error(), http.StatusForbidden)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return newProblem(problemConnection, "timeout fetching "+domain, http.StatusForbidden)
	}
	return newProblem(problemConnection, "connection error fetching "+domain+": "+err.Error(), http.StatusForbidden)
}
