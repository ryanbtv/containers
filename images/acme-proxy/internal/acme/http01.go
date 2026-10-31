package acme

import (
	"context"
	"errors"
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

// Validate fetches the token URL and compares the body with keyAuth.
// Redirects are followed per RFC 8555 §8.3. It returns nil on success or an
// ACME problem suitable for the authorization error object.
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
		Transport: &http.Transport{
			DialContext: dial,
			// Port 80 only, per spec. No TLS: the URL scheme is http.
			DisableKeepAlives: true,
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
