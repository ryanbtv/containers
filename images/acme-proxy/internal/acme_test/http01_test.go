package acme_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/go-jose/go-jose/v4"

	"github.com/ryanbtv/containers/images/acme-proxy/internal/acme"
)

// startHTTP01Challenge creates an order for domain, reads its single
// http-01 challenge, presents the given raw answer under the advertised
// token, and returns the authz URL, challenge URL, and advertised token.
// An answer prefixed "REDIRECT:" is served as a 302 to the remainder.
func startHTTP01Challenge(t *testing.T, env *testEnv, key jose.JSONWebKey, domain, answer string) (authzURL, chalURL, token string) {
	t.Helper()
	kid := accountURL(t, env, key)
	res := newOrder(t, env, key, `{"identifiers":[{"type":"dns","value":"`+domain+`"}]}`)
	if res.Status != 201 {
		t.Fatalf("newOrder = %d %s", res.Status, res.Body)
	}
	var order map[string]any
	if err := json.Unmarshal(res.Body, &order); err != nil {
		t.Fatal(err)
	}
	authzURL = order["authorizations"].([]any)[0].(string)

	nonce := env.getNonce(t)
	r := env.post(t, authzURL, key, kid, nonce, "")
	var authz struct {
		Challenges []struct {
			URL   string `json:"url"`
			Token string `json:"token"`
		} `json:"challenges"`
	}
	if err := json.Unmarshal(r.Body, &authz); err != nil {
		t.Fatal(err)
	}
	if len(authz.Challenges) != 1 {
		t.Fatalf("challenges = %d, want 1", len(authz.Challenges))
	}
	if err := env.solver.Present(context.Background(), domain, authz.Challenges[0].Token, answer); err != nil {
		t.Fatal(err)
	}
	return authzURL, authz.Challenges[0].URL, authz.Challenges[0].Token
}

func triggerValidation(t *testing.T, env *testEnv, chalURL string, key jose.JSONWebKey) {
	t.Helper()
	kid := accountURL(t, env, key)
	nonce := env.getNonce(t)
	if r := env.post(t, chalURL, key, kid, nonce, "{}"); r.Status != 200 {
		t.Fatalf("challenge POST = %d %s", r.Status, r.Body)
	}
}

func authzStatusError(t *testing.T, env *testEnv, authzURL string, key jose.JSONWebKey) (status, raw string) {
	t.Helper()
	kid := accountURL(t, env, key)
	nonce := env.getNonce(t)
	r := env.post(t, authzURL, key, kid, nonce, "")
	var a struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(r.Body, &a); err != nil {
		t.Fatal(err)
	}
	return a.Status, string(r.Body)
}

// TestHTTP01SameHostRedirectFollowed checks the validator follows a same-host
// redirect (relative Location, implicit port 80) — the common nginx/certbot
// "redirect everything to HTTPS-except-wellknown" neighbor case — and the
// challenge then validates.
func TestHTTP01SameHostRedirectFollowed(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)
	thumb, err := acme.Thumbprint(&key)
	if err != nil {
		t.Fatal(err)
	}
	domain := "redir-same.ryanb.tv"

	const sentinel = "sentinel-token"
	authzURL, chalURL, token := startHTTP01Challenge(t, env, key, domain,
		"REDIRECT:/.well-known/acme-challenge/"+sentinel)

	// The redirect lands on the sentinel path; the served key authorization
	// must still echo the ADVERTISED token (RFC 8555 §8.3: redirects do not
	// change the expected key authorization).
	if err := env.solver.Present(context.Background(), domain, sentinel,
		acme.KeyAuthorization(token, thumb)); err != nil {
		t.Fatal(err)
	}

	triggerValidation(t, env, chalURL, key)
	status, raw := authzStatusError(t, env, authzURL, key)
	if status != "valid" {
		t.Fatalf("same-host redirect: authz = %s, want valid (%s)", status, raw)
	}
}

// TestHTTP01CrossHostRedirectRefused checks the SSRF guard: a redirect to a
// host other than the identifier host must be refused BEFORE the target is
// dialed, marking the authz invalid with a connection-class problem.
func TestHTTP01CrossHostRedirectRefused(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)
	domain := "redir-cross.ryanb.tv"

	// The injected dialer routes ALL hosts to the in-process solve server,
	// so an unguarded follow would resolve this host and process its answer.
	// The guard must reject it in CheckRedirect instead.
	authzURL, chalURL, _ := startHTTP01Challenge(t, env, key, domain,
		"REDIRECT:http://internal-target.example.invalid/.well-known/acme-challenge/x")

	triggerValidation(t, env, chalURL, key)
	status, raw := authzStatusError(t, env, authzURL, key)
	if status != "invalid" {
		t.Fatalf("cross-host redirect: authz = %s, want invalid (%s)", status, raw)
	}
	if !strings.Contains(raw, "redirect refused") ||
		!strings.Contains(raw, "urn:ietf:params:acme:error:connection") {
		t.Fatalf("cross-host redirect: want redirect-refused connection error, got %s", raw)
	}
}

// TestHTTP01PortRedirectRefused checks the guard rejects a same-host redirect
// to a port other than 80/443 (e.g. probing an internal admin port).
func TestHTTP01PortRedirectRefused(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)
	domain := "redir-port.ryanb.tv"

	authzURL, chalURL, _ := startHTTP01Challenge(t, env, key, domain,
		"REDIRECT:http://"+domain+":9090/.well-known/acme-challenge/x")

	triggerValidation(t, env, chalURL, key)
	status, raw := authzStatusError(t, env, authzURL, key)
	if status != "invalid" {
		t.Fatalf("bad-port redirect: authz = %s, want invalid (%s)", status, raw)
	}
	if !strings.Contains(raw, "ports 80 and 443") {
		t.Fatalf("bad-port redirect: want port-refused detail, got %s", raw)
	}
}
