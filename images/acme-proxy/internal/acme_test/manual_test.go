package acme_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/go-jose/go-jose/v4"

	"github.com/ryanbtv/containers/images/acme-proxy/internal/acme"
)

// TestManualAcmeFlowAndRevoke walks the whole protocol with hand-rolled
// signed requests (no lego): order → authz → challenge (answer presented to
// the test solver, fetched through the injected dialer) → ready → finalize →
// certificate download → revoke by certificate-key jwk → alreadyRevoked on a
// second revoke with the account kid.
func TestManualAcmeFlowAndRevoke(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	acctKey := createAccount(t, env)
	kid := accountURL(t, env, acctKey)
	thumb, err := acme.Thumbprint(&acctKey)
	if err != nil {
		t.Fatal(err)
	}

	// Order.
	res := newOrder(t, env, acctKey, `{"identifiers":[{"type":"dns","value":"manual.ryanb.tv"}]}`)
	if res.Status != 201 {
		t.Fatalf("newOrder = %d %s", res.Status, res.Body)
	}
	orderURL := res.Header.Get("Location")
	var order map[string]any
	if err := json.Unmarshal(res.Body, &order); err != nil {
		t.Fatal(err)
	}
	authzURLs, _ := order["authorizations"].([]any)
	if len(authzURLs) != 1 {
		t.Fatalf("authorizations = %v", order["authorizations"])
	}
	authzURL := authzURLs[0].(string)

	// Authz: read token + challenge URL.
	nonce := env.getNonce(t)
	r := env.post(t, authzURL, acctKey, kid, nonce, "")
	if r.Status != 200 {
		t.Fatalf("authz read = %d %s", r.Status, r.Body)
	}
	var authz struct {
		Status     string `json:"status"`
		Challenges []struct {
			Type  string `json:"type"`
			URL   string `json:"url"`
			Token string `json:"token"`
		} `json:"challenges"`
	}
	if err := json.Unmarshal(r.Body, &authz); err != nil {
		t.Fatal(err)
	}
	if authz.Status != "pending" || len(authz.Challenges) != 1 {
		t.Fatalf("authz = %+v", authz)
	}
	chal := authz.Challenges[0]

	// Present the key authorization where the validator (dialer-routed to
	// env.solve) will fetch it.
	keyAuth := acme.KeyAuthorization(chal.Token, thumb)
	if err := env.solver.Present(context.Background(), "manual.ryanb.tv", chal.Token, keyAuth); err != nil {
		t.Fatal(err)
	}

	// Trigger validation.
	nonce = env.getNonce(t)
	r = env.post(t, chal.URL, acctKey, kid, nonce, "{}")
	if r.Status != 200 {
		t.Fatalf("challenge POST = %d %s", r.Status, r.Body)
	}

	// Authz now valid.
	nonce = env.getNonce(t)
	r = env.post(t, authzURL, acctKey, kid, nonce, "")
	if err := json.Unmarshal(r.Body, &authz); err != nil {
		t.Fatal(err)
	}
	if authz.Status != "valid" {
		t.Fatalf("authz after validation = %s: %s", authz.Status, r.Body)
	}

	// Order now ready.
	nonce = env.getNonce(t)
	r = env.post(t, orderURL, acctKey, kid, nonce, "")
	var ready struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(r.Body, &ready); err != nil {
		t.Fatal(err)
	}
	if ready.Status != "ready" {
		t.Fatalf("order status = %s, want ready", ready.Status)
	}

	// Finalize with the client CSR.
	csrDER, _, certKey := makeCSR(t, "manual.ryanb.tv")
	payload := fmt.Sprintf(`{"csr":"%s"}`, base64.RawURLEncoding.EncodeToString(csrDER))
	nonce = env.getNonce(t)
	r = env.post(t, orderURL+"/finalize", acctKey, kid, nonce, payload)
	if r.Status != 200 {
		t.Fatalf("finalize = %d %s", r.Status, r.Body)
	}
	var done struct {
		Status      string `json:"status"`
		Certificate string `json:"certificate"`
	}
	if err := json.Unmarshal(r.Body, &done); err != nil {
		t.Fatal(err)
	}
	if done.Status != "valid" || done.Certificate == "" {
		t.Fatalf("finalized order = %+v", done)
	}

	// Certificate download over POST-as-GET with the chain content type.
	nonce = env.getNonce(t)
	certResp := env.post(t, done.Certificate, acctKey, kid, nonce, "")
	if certResp.Status != 200 {
		t.Fatalf("certificate GET = %d %s", certResp.Status, certResp.Body)
	}
	if ct := certResp.Header.Get("Content-Type"); ct != "application/pem-certificate-chain" {
		t.Errorf("certificate content type = %q", ct)
	}
	if !strings.HasPrefix(string(certResp.Body), "-----BEGIN CERTIFICATE-----") {
		t.Error("certificate body is not PEM")
	}
	chain := parseChain(t, certResp.Body)
	if chain[0].DNSNames[0] != "manual.ryanb.tv" {
		t.Errorf("leaf SANs = %v", chain[0].DNSNames)
	}

	// Finalize replay on a valid order returns the same order (200).
	nonce = env.getNonce(t)
	r = env.post(t, orderURL+"/finalize", acctKey, kid, nonce, payload)
	if r.Status != 200 {
		t.Fatalf("finalize replay = %d, want 200", r.Status)
	}

	// Revoke with the certificate's own key in jwk form.
	certJWK := jose.JSONWebKey{Key: certKey}
	certB64 := base64.RawURLEncoding.EncodeToString(chain[0].Raw)
	nonce = env.getNonce(t)
	r = env.post(t, env.Server.URL+"/acme/revoke-cert", certJWK, "", nonce,
		fmt.Sprintf(`{"certificate":"%s","reason":1}`, certB64))
	if r.Status != 200 {
		t.Fatalf("jwk (cert key) revoke = %d %s", r.Status, r.Body)
	}

	// Second revoke by the account kid → alreadyRevoked, reason honored on
	// the first call and stored (checked via list API).
	nonce = env.getNonce(t)
	r = env.post(t, env.Server.URL+"/acme/revoke-cert", acctKey, kid, nonce,
		fmt.Sprintf(`{"certificate":"%s"}`, certB64))
	if r.Status != 403 || problemType(t, r.Body) != "urn:ietf:params:acme:error:alreadyRevoked" {
		t.Fatalf("second revoke = %d %s, want 403 alreadyRevoked", r.Status, r.Body)
	}

	apiResp, err := env.Server.Client().Get(env.Server.URL + "/api/v1/certificates")
	if err != nil {
		t.Fatal(err)
	}
	defer apiResp.Body.Close()
	var list struct {
		Certificates []struct {
			Revoked       bool `json:"revoked"`
			DaysRemaining int  `json:"days_remaining"`
		} `json:"certificates"`
	}
	if err := json.NewDecoder(apiResp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Certificates) != 1 || !list.Certificates[0].Revoked {
		t.Fatalf("api list after revoke = %+v", list.Certificates)
	}
}

// issueWithAccount drives order → validation → finalize → download for a
// hand-rolled client key and returns the leaf certificate DER.
func issueWithAccount(t *testing.T, env *testEnv, acctKey jose.JSONWebKey, domain string) []byte {
	t.Helper()
	kid := accountURL(t, env, acctKey)
	thumb, err := acme.Thumbprint(&acctKey)
	if err != nil {
		t.Fatal(err)
	}

	res := newOrder(t, env, acctKey, fmt.Sprintf(`{"identifiers":[{"type":"dns","value":"%s"}]}`, domain))
	if res.Status != 201 {
		t.Fatalf("newOrder = %d %s", res.Status, res.Body)
	}
	orderURL := res.Header.Get("Location")
	var order map[string]any
	if err := json.Unmarshal(res.Body, &order); err != nil {
		t.Fatal(err)
	}
	authzURL := order["authorizations"].([]any)[0].(string)

	nonce := env.getNonce(t)
	r := env.post(t, authzURL, acctKey, kid, nonce, "")
	var authz struct {
		Challenges []struct {
			URL   string `json:"url"`
			Token string `json:"token"`
		} `json:"challenges"`
	}
	if err := json.Unmarshal(r.Body, &authz); err != nil {
		t.Fatal(err)
	}
	chal := authz.Challenges[0]
	if err := env.solver.Present(context.Background(), domain, chal.Token,
		acme.KeyAuthorization(chal.Token, thumb)); err != nil {
		t.Fatal(err)
	}

	nonce = env.getNonce(t)
	if r = env.post(t, chal.URL, acctKey, kid, nonce, "{}"); r.Status != 200 {
		t.Fatalf("challenge POST = %d %s", r.Status, r.Body)
	}

	csrDER, _, _ := makeCSR(t, domain)
	payload := fmt.Sprintf(`{"csr":"%s"}`, base64.RawURLEncoding.EncodeToString(csrDER))
	nonce = env.getNonce(t)
	if r = env.post(t, orderURL+"/finalize", acctKey, kid, nonce, payload); r.Status != 200 {
		t.Fatalf("finalize = %d %s", r.Status, r.Body)
	}
	var done struct {
		Certificate string `json:"certificate"`
	}
	if err := json.Unmarshal(r.Body, &done); err != nil || done.Certificate == "" {
		t.Fatalf("finalize body = %s", r.Body)
	}

	nonce = env.getNonce(t)
	certResp := env.post(t, done.Certificate, acctKey, kid, nonce, "")
	if certResp.Status != 200 {
		t.Fatalf("certificate download = %d", certResp.Status)
	}
	return parseChain(t, certResp.Body)[0].Raw
}

// TestRevocationAuthorizationPrecedesMutation guards RFC 8555 §7.6: the
// signing key must be verified as authorized BEFORE the certificate is
// revoked. A foreign key revoking a LIVE certificate must get 403
// unauthorized and must leave the certificate unrevoked.
func TestRevocationAuthorizationPrecedesMutation(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	acctKey := createAccount(t, env)
	kid := accountURL(t, env, acctKey)
	leafDER := issueWithAccount(t, env, acctKey, "live-revoke.ryanb.tv")

	foreign := newAccountKey(t)
	certB64 := base64.RawURLEncoding.EncodeToString(leafDER)
	nonce := env.getNonce(t)
	res := env.post(t, env.Server.URL+"/acme/revoke-cert", foreign, "", nonce,
		fmt.Sprintf(`{"certificate":"%s"}`, certB64))
	if res.Status != 403 || problemType(t, res.Body) != "urn:ietf:params:acme:error:unauthorized" {
		t.Fatalf("foreign revoke of live cert = %d %s, want 403 unauthorized", res.Status, res.Body)
	}

	certs, err := env.store.ListCertificates(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(certs) != 1 || certs[0].Revoked {
		t.Fatalf("certificate revoked despite failed authorization: %+v", certs)
	}

	// Positive control: the owning account can still revoke it.
	nonce = env.getNonce(t)
	res = env.post(t, env.Server.URL+"/acme/revoke-cert", acctKey, kid, nonce,
		fmt.Sprintf(`{"certificate":"%s"}`, certB64))
	if res.Status != 200 {
		t.Fatalf("owner revoke = %d %s, want 200", res.Status, res.Body)
	}
}

// TestChallengeValidationFailureMarksOrderInvalid removes the answer before
// validation so the fetch 404s: authz must end invalid with an ACME error
// object and the order must become invalid.
func TestChallengeValidationFailureMarksOrderInvalid(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	acctKey := createAccount(t, env)
	kid := accountURL(t, env, acctKey)

	res := newOrder(t, env, acctKey, `{"identifiers":[{"type":"dns","value":"missing.ryanb.tv"}]}`)
	orderURL := res.Header.Get("Location")
	var order map[string]any
	_ = json.Unmarshal(res.Body, &order)
	authzURL := order["authorizations"].([]any)[0].(string)

	nonce := env.getNonce(t)
	r := env.post(t, authzURL, acctKey, kid, nonce, "")
	var authz struct {
		Challenges []struct {
			URL   string `json:"url"`
			Token string `json:"token"`
		} `json:"challenges"`
	}
	_ = json.Unmarshal(r.Body, &authz)

	// Deliberately present nothing: the solve server answers 404.
	nonce = env.getNonce(t)
	r = env.post(t, authz.Challenges[0].URL, acctKey, kid, nonce, "{}")
	if r.Status != 200 {
		t.Fatalf("challenge POST = %d %s", r.Status, r.Body)
	}

	nonce = env.getNonce(t)
	r = env.post(t, authzURL, acctKey, kid, nonce, "")
	if !strings.Contains(string(r.Body), "invalid") {
		t.Fatalf("authz after failed validation = %s", r.Body)
	}
	if !strings.Contains(string(r.Body), "urn:ietf:params:acme:error:") {
		t.Fatalf("authz error missing ACME urn: %s", r.Body)
	}

	nonce = env.getNonce(t)
	r = env.post(t, orderURL, acctKey, kid, nonce, "")
	if !strings.Contains(string(r.Body), `"status":"invalid"`) {
		t.Fatalf("order after failed validation = %s", r.Body)
	}
}

// TestKeyAuthorizationWrongBody checks the validator rejects a wrong body.
func TestKeyAuthorizationWrongBody(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	acctKey := createAccount(t, env)
	kid := accountURL(t, env, acctKey)

	res := newOrder(t, env, acctKey, `{"identifiers":[{"type":"dns","value":"wrong.ryanb.tv"}]}`)
	var order map[string]any
	_ = json.Unmarshal(res.Body, &order)
	authzURL := order["authorizations"].([]any)[0].(string)

	nonce := env.getNonce(t)
	r := env.post(t, authzURL, acctKey, kid, nonce, "")
	var authz struct {
		Challenges []struct {
			URL   string `json:"url"`
			Token string `json:"token"`
		} `json:"challenges"`
	}
	_ = json.Unmarshal(r.Body, &authz)

	// Present the WRONG key authorization.
	_ = env.solver.Present(context.Background(), "wrong.ryanb.tv", authz.Challenges[0].Token, "nope.nope")

	nonce = env.getNonce(t)
	r = env.post(t, authz.Challenges[0].URL, acctKey, kid, nonce, "{}")
	if r.Status != 200 {
		t.Fatalf("challenge = %d", r.Status)
	}
	nonce = env.getNonce(t)
	r = env.post(t, authzURL, acctKey, kid, nonce, "")
	if !strings.Contains(string(r.Body), "invalid") ||
		!strings.Contains(string(r.Body), "unauthorized") {
		t.Fatalf("authz with wrong key auth = %s, want invalid/unauthorized", r.Body)
	}
}
