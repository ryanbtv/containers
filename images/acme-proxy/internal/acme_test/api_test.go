package acme_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"

	"github.com/ryanbtv/containers/images/acme-proxy/internal/acme"
)

func TestDirectoryShape(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	req, _ := http.NewRequest("GET", env.Server.URL+"/directory", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "acme.sff.k8s.ryanb.tv")
	resp, err := env.Server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var doc map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"newNonce", "newAccount", "newOrder", "revokeCert"} {
		got, _ := doc[key].(string)
		if !strings.HasPrefix(got, "https://acme.sff.k8s.ryanb.tv/acme/") {
			t.Errorf("directory[%s] = %q, want absolute public URL", key, got)
		}
	}
	meta, _ := doc["meta"].(map[string]any)
	caa, _ := meta["caaIdentities"].([]any)
	if len(caa) != 1 || caa[0] != "letsencrypt.org" {
		t.Errorf("meta.caaIdentities = %v, want [letsencrypt.org]", meta["caaIdentities"])
	}
	if _, present := doc["externalAccountRequired"]; present {
		t.Error("directory must not advertise externalAccountRequired")
	}
	if _, present := doc["keyChange"]; present {
		t.Error("directory must not advertise keyChange")
	}

	// /.well-known/acme-directory serves the same document.
	resp2, err := env.Server.Client().Get(env.Server.URL + "/.well-known/acme-directory")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Errorf("/.well-known/acme-directory status = %d", resp2.StatusCode)
	}
}

func TestNewNonceMethods(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)

	head, err := env.Server.Client().Head(env.Server.URL + "/acme/new-nonce")
	if err != nil {
		t.Fatal(err)
	}
	defer head.Body.Close()
	if head.StatusCode != 200 || head.Header.Get("Replay-Nonce") == "" {
		t.Errorf("HEAD newNonce = %d nonce=%q, want 200 with Replay-Nonce", head.StatusCode, head.Header.Get("Replay-Nonce"))
	}

	resp, err := env.Server.Client().Get(env.Server.URL + "/acme/new-nonce")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 204 || resp.Header.Get("Replay-Nonce") == "" {
		t.Errorf("GET newNonce = %d nonce=%q, want 204 with Replay-Nonce", resp.StatusCode, resp.Header.Get("Replay-Nonce"))
	}
}

// createAccount POSTs newAccount with a fresh key and returns the key.
func createAccount(t *testing.T, env *testEnv) jose.JSONWebKey {
	t.Helper()
	key := newAccountKey(t)
	nonce := env.getNonce(t)
	res := env.post(t, env.Server.URL+"/acme/new-account", key, "", nonce, `{"termsOfServiceAgreed":true}`)
	if res.Status != 201 {
		t.Fatalf("newAccount status = %d body=%s", res.Status, res.Body)
	}
	return key
}

func TestAccountLifecycle(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)

	// Re-POST newAccount with the same key returns 200, not 201.
	nonce := env.getNonce(t)
	res := env.post(t, env.Server.URL+"/acme/new-account", key, "", nonce, `{"termsOfServiceAgreed":true}`)
	if res.Status != 200 {
		t.Fatalf("duplicate newAccount status = %d, want 200; body=%s", res.Status, res.Body)
	}
	loc := res.Header.Get("Location")
	if !strings.HasPrefix(loc, env.Server.URL+"/acme/account/") {
		t.Fatalf("Location = %q", loc)
	}

	// onlyReturnExisting with the same key finds the account (key-rollover
	// pre-check path used by certbot and acme.sh).
	nonce = env.getNonce(t)
	res = env.post(t, env.Server.URL+"/acme/new-account", key, "", nonce, `{"onlyReturnExisting":true}`)
	if res.Status != 200 {
		t.Fatalf("onlyReturnExisting known key = %d, want 200", res.Status)
	}

	// onlyReturnExisting with an unknown key → accountDoesNotExist.
	nonce = env.getNonce(t)
	res = env.post(t, env.Server.URL+"/acme/new-account", newAccountKey(t), "", nonce, `{"onlyReturnExisting":true}`)
	if res.Status != 403 || problemType(t, res.Body) != "urn:ietf:params:acme:error:accountDoesNotExist" {
		t.Fatalf("onlyReturnExisting unknown key = %d %s, want 403 accountDoesNotExist", res.Status, res.Body)
	}

	// Deactivate via kid, then reject further requests.
	nonce = env.getNonce(t)
	res = env.post(t, loc, key, loc, nonce, `{"status":"deactivated"}`)
	if res.Status != 200 || !strings.Contains(string(res.Body), "deactivated") {
		t.Fatalf("deactivate = %d %s", res.Status, res.Body)
	}
	nonce = env.getNonce(t)
	res = env.post(t, loc, key, loc, nonce, "")
	if res.Status != 401 || problemType(t, res.Body) != "urn:ietf:params:acme:error:unauthorized" {
		t.Fatalf("request as deactivated account = %d %s, want 401 unauthorized", res.Status, res.Body)
	}
}

func TestNonceSingleUse(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)

	nonce := env.getNonce(t)
	res := env.post(t, env.Server.URL+"/acme/new-order", key, accountURL(t, env, key), nonce,
		`{"identifiers":[{"type":"dns","value":"a.ryanb.tv"}]}`)
	if res.Status != 201 {
		t.Fatalf("newOrder = %d %s", res.Status, res.Body)
	}

	// Reuse: same nonce must fail badNonce, and the error response carries a
	// fresh nonce for retry.
	res2 := env.post(t, env.Server.URL+"/acme/new-order", key, accountURL(t, env, key), nonce,
		`{"identifiers":[{"type":"dns","value":"b.ryanb.tv"}]}`)
	if res2.Status != 400 || problemType(t, res2.Body) != "urn:ietf:params:acme:error:badNonce" {
		t.Fatalf("nonce reuse = %d %s, want 400 badNonce", res2.Status, res2.Body)
	}
	fresh := res2.Header.Get("Replay-Nonce")
	if fresh == "" || fresh == nonce {
		t.Fatalf("error response Replay-Nonce = %q, want fresh nonce", fresh)
	}

	// badNonce retry succeeds with the fresh nonce.
	res3 := env.post(t, env.Server.URL+"/acme/new-order", key, accountURL(t, env, key), fresh,
		`{"identifiers":[{"type":"dns","value":"b.ryanb.tv"}]}`)
	if res3.Status != 201 {
		t.Fatalf("badNonce retry = %d %s, want 201", res3.Status, res3.Body)
	}
}

// accountURL fetches the account Location for a key by POSTing newAccount.
func accountURL(t *testing.T, env *testEnv, key jose.JSONWebKey) string {
	t.Helper()
	nonce := env.getNonce(t)
	res := env.post(t, env.Server.URL+"/acme/new-account", key, "", nonce, `{"onlyReturnExisting":true}`)
	if res.Status != 200 {
		t.Fatalf("account lookup = %d %s", res.Status, res.Body)
	}
	return res.Header.Get("Location")
}

func newOrder(t *testing.T, env *testEnv, key jose.JSONWebKey, payload string) postResult {
	t.Helper()
	nonce := env.getNonce(t)
	return env.post(t, env.Server.URL+"/acme/new-order", key, accountURL(t, env, key), nonce, payload)
}

func TestNewOrderIdentifierRules(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)

	cases := []struct {
		name, payload, wantType string
		wantStatus              int
	}{
		{"allowed apex", `{"identifiers":[{"type":"dns","value":"ryanb.tv"}]}`, "", 201},
		{"allowed sub", `{"identifiers":[{"type":"dns","value":"Home.ryanb.tv"}]}`, "", 201},
		{"allowed deep sub", `{"identifiers":[{"type":"dns","value":"a.b.c.ryanb.tv"}]}`, "", 201},
		{"denied foreign", `{"identifiers":[{"type":"dns","value":"evil.example.com"}]}`,
			"urn:ietf:params:acme:error:rejectedIdentifier", 400},
		{"denied lookalike suffix", `{"identifiers":[{"type":"dns","value":"notryanb.tv"}]}`,
			"urn:ietf:params:acme:error:rejectedIdentifier", 400},
		{"denied wildcard", `{"identifiers":[{"type":"dns","value":"*.ryanb.tv"}]}`,
			"urn:ietf:params:acme:error:rejectedIdentifier", 400},
		{"unsupported id type", `{"identifiers":[{"type":"ip","value":"1.2.3.4"}]}`,
			"urn:ietf:params:acme:error:unsupportedIdentifier", 400},
		{"empty identifiers", `{"identifiers":[]}`, "urn:ietf:params:acme:error:malformed", 400},
		{"garbage name", `{"identifiers":[{"type":"dns","value":"-bad-"}]}`, "urn:ietf:params:acme:error:malformed", 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := newOrder(t, env, key, tc.payload)
			if res.Status != tc.wantStatus {
				t.Fatalf("status = %d body=%s, want %d", res.Status, res.Body, tc.wantStatus)
			}
			if tc.wantType != "" && problemType(t, res.Body) != tc.wantType {
				t.Fatalf("problem = %s, want %s", res.Body, tc.wantType)
			}
		})
	}
}

func TestOrderObjectShapeAndPOSTAsGET(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)
	kid := accountURL(t, env, key)

	res := newOrder(t, env, key, `{"identifiers":[{"type":"dns","value":"www.ryanb.tv"}]}`)
	if res.Status != 201 {
		t.Fatalf("newOrder = %d %s", res.Status, res.Body)
	}
	var order struct {
		Status         string              `json:"status"`
		Authorizations []string            `json:"authorizations"`
		Finalize       string              `json:"finalize"`
		Identifiers    []map[string]string `json:"identifiers"`
		Expires        string              `json:"expires"`
	}
	if err := json.Unmarshal(res.Body, &order); err != nil {
		t.Fatal(err)
	}
	if order.Status != "pending" {
		t.Errorf("order status = %q, want pending", order.Status)
	}
	if len(order.Authorizations) != 1 {
		t.Fatalf("authorizations = %v", order.Authorizations)
	}
	if len(order.Identifiers) != 1 || order.Identifiers[0]["value"] != "www.ryanb.tv" {
		t.Errorf("identifiers = %v", order.Identifiers)
	}

	// POST-as-GET read of the order.
	nonce := env.getNonce(t)
	r := env.post(t, res.Header.Get("Location"), key, kid, nonce, "")
	if r.Status != 200 {
		t.Fatalf("order POST-as-GET = %d %s", r.Status, r.Body)
	}

	// Non-empty payload to the read endpoint → malformed.
	nonce = env.getNonce(t)
	r = env.post(t, res.Header.Get("Location"), key, kid, nonce, `{"poke":true}`)
	if r.Status != 400 || problemType(t, r.Body) != "urn:ietf:params:acme:error:malformed" {
		t.Fatalf("order with payload = %d %s, want 400 malformed", r.Status, r.Body)
	}

	// Authorization object lists only http-01, with a token.
	nonce = env.getNonce(t)
	r = env.post(t, order.Authorizations[0], key, kid, nonce, "")
	if r.Status != 200 {
		t.Fatalf("authz POST-as-GET = %d %s", r.Status, r.Body)
	}
	var authz struct {
		Identifier map[string]string `json:"identifier"`
		Status     string            `json:"status"`
		Challenges []struct {
			Type  string `json:"type"`
			URL   string `json:"url"`
			Token string `json:"token"`
		} `json:"challenges"`
	}
	if err := json.Unmarshal(r.Body, &authz); err != nil {
		t.Fatal(err)
	}
	if len(authz.Challenges) != 1 || authz.Challenges[0].Type != "http-01" {
		t.Fatalf("challenges = %+v, want exactly one http-01", authz.Challenges)
	}
	if authz.Challenges[0].Token == "" || authz.Challenges[0].URL == "" {
		t.Error("challenge missing token/url")
	}
	if authz.Identifier["type"] != "dns" || authz.Identifier["value"] != "www.ryanb.tv" {
		t.Errorf("authz identifier = %v", authz.Identifier)
	}

	// Unknown challenge id under an authz → 404.
	nonce = env.getNonce(t)
	badChallenge := strings.TrimSuffix(authz.Challenges[0].URL, "/1") + "/7"
	r = env.post(t, badChallenge, key, kid, nonce, "{}")
	if r.Status != 404 {
		t.Fatalf("unknown challenge id = %d, want 404", r.Status)
	}
}

func TestJWSRejections(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)
	kid := accountURL(t, env, key)

	t.Run("wrong url header", func(t *testing.T) {
		nonce := env.getNonce(t)
		body := sign(t, key, "", env.Server.URL+"/acme/new-order", nonce, kid)
		resp, err := env.Server.Client().Post(env.Server.URL+"/acme/order/1", "application/jose+json", strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("status = %d, want 400 url mismatch", resp.StatusCode)
		}
	})

	t.Run("kid of another account with this key signature", func(t *testing.T) {
		other := createAccount(t, env)
		otherKid := accountURL(t, env, other)
		nonce := env.getNonce(t)
		body := sign(t, key, "", otherKid, nonce, otherKid) // signed with key, kid of other
		resp, err := env.Server.Client().Post(env.Server.URL+"/acme/order/1", "application/jose+json", strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("status = %d, want 400 signature failure", resp.StatusCode)
		}
	})

	t.Run("jwk and kid together", func(t *testing.T) {
		nonce := env.getNonce(t)
		// Embed both: manually craft via sign (jwk) then post to kid endpoint
		// with kid in header.
		body := signWithJWKAndKid(t, key, kid, nonce, env.Server.URL+"/acme/new-order")
		resp, err := env.Server.Client().Post(env.Server.URL+"/acme/new-order", "application/jose+json", strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("status = %d, want 400 jwk XOR kid", resp.StatusCode)
		}
	})
}

// signWithJWKAndKid crafts a protected header carrying both jwk and kid.
func signWithJWKAndKid(t *testing.T, key jose.JSONWebKey, kid, nonce, url string) []byte {
	t.Helper()
	opts := jose.SignerOptions{EmbedJWK: true}
	opts = *opts.WithHeader(jose.HeaderKey("url"), url).
		WithHeader(jose.HeaderKey("nonce"), nonce).
		WithHeader(jose.HeaderKey("kid"), kid)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, &opts)
	if err != nil {
		t.Fatal(err)
	}
	obj, err := signer.Sign([]byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	return []byte(obj.FullSerialize())
}

func TestRS256AccountAccepted(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	key := jose.JSONWebKey{Key: rsaKey}
	nonce := env.getNonce(t)

	opts := jose.SignerOptions{EmbedJWK: true}
	opts = *opts.WithHeader(jose.HeaderKey("url"), env.Server.URL+"/acme/new-account").
		WithHeader(jose.HeaderKey("nonce"), nonce)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, &opts)
	if err != nil {
		t.Fatal(err)
	}
	obj, err := signer.Sign([]byte(`{"termsOfServiceAgreed":true}`))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := env.Server.Client().Post(env.Server.URL+"/acme/new-account", "application/jose+json",
		strings.NewReader(obj.FullSerialize()))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 201 {
		t.Fatalf("RS256 newAccount = %d, want 201", resp.StatusCode)
	}
}

func TestRevocationReasonValidation(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)
	kid := accountURL(t, env, key)
	nonce := env.getNonce(t)
	res := env.post(t, env.Server.URL+"/acme/revoke-cert", key, kid, nonce, `{"certificate":"AAA","reason":99}`)
	if res.Status != 400 || problemType(t, res.Body) != "urn:ietf:params:acme:error:badRevocationReason" {
		t.Fatalf("bad reason = %d %s, want 400 badRevocationReason", res.Status, res.Body)
	}
}

func TestOrderAccessIsolation(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	keyA := createAccount(t, env)
	keyB := createAccount(t, env)

	res := newOrder(t, env, keyA, `{"identifiers":[{"type":"dns","value":"x.ryanb.tv"}]}`)
	if res.Status != 201 {
		t.Fatalf("newOrder = %d %s", res.Status, res.Body)
	}
	nonce := env.getNonce(t)
	r := env.post(t, res.Header.Get("Location"), keyB, accountURL(t, env, keyB), nonce, "")
	if r.Status != 404 {
		t.Fatalf("other account reading order = %d, want 404", r.Status)
	}
}

func TestFinalizeRejectsOrderNotReady(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	key := createAccount(t, env)
	kid := accountURL(t, env, key)
	res := newOrder(t, env, key, `{"identifiers":[{"type":"dns","value":"p.ryanb.tv"}]}`)
	nonce := env.getNonce(t)
	r := env.post(t, res.Header.Get("Location")+"/finalize", key, kid, nonce, `{"csr":"AAAA"}`)
	if r.Status != 403 || problemType(t, r.Body) != "urn:ietf:params:acme:error:orderNotReady" {
		t.Fatalf("finalize pending order = %d %s, want 403 orderNotReady", r.Status, r.Body)
	}
}

// TestConcurrentFinalizeIssuesOnce asserts the ready → processing transition
// is exclusive: two simultaneous finalize POSTs must produce exactly ONE
// upstream issuance, and neither may 500.
func TestConcurrentFinalizeIssuesOnce(t *testing.T) {
	ci := &countingIssuer{ca: newTestCA(t), hold: 150 * time.Millisecond}
	env := newEnv(t, newMemStore(), ci)
	key := createAccount(t, env)
	kid := accountURL(t, env, key)

	res := newOrder(t, env, key, `{"identifiers":[{"type":"dns","value":"race.ryanb.tv"}]}`)
	orderURL := res.Header.Get("Location")
	var order map[string]any
	if err := json.Unmarshal(res.Body, &order); err != nil {
		t.Fatal(err)
	}
	authzURL := order["authorizations"].([]any)[0].(string)
	thumb, err := acme.Thumbprint(&key)
	if err != nil {
		t.Fatal(err)
	}
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
	if err := env.solver.Present(context.Background(), "race.ryanb.tv",
		authz.Challenges[0].Token, acme.KeyAuthorization(authz.Challenges[0].Token, thumb)); err != nil {
		t.Fatal(err)
	}
	nonce = env.getNonce(t)
	if r = env.post(t, authz.Challenges[0].URL, key, kid, nonce, "{}"); r.Status != 200 {
		t.Fatalf("challenge = %d %s", r.Status, r.Body)
	}

	csrDER, _, _ := makeCSR(t, "race.ryanb.tv")
	payload := fmt.Sprintf(`{"csr":"%s"}`, base64.RawURLEncoding.EncodeToString(csrDER))

	// Sign both finalize requests up front with fresh nonces, then release
	// them simultaneously.
	bodies := make([][]byte, 2)
	for i := range bodies {
		bodies[i] = sign(t, key, payload, orderURL+"/finalize", env.getNonce(t), kid)
	}
	statuses := make([]int, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range bodies {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			resp, err := env.Server.Client().Post(orderURL+"/finalize",
				"application/jose+json", bytes.NewReader(bodies[i]))
			if err != nil {
				return
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, resp.Body)
			statuses[i] = resp.StatusCode
		}(i)
	}
	close(start)
	wg.Wait()

	if n := ci.count(); n != 1 {
		t.Fatalf("upstream issued %d times, want exactly 1 (statuses %v)", n, statuses)
	}
	any200 := false
	for _, s := range statuses {
		switch s {
		case 200: // winner; a loser that re-reads after completion may also replay 200
			any200 = true
		case 403: // loser polling an in-flight order (orderNotReady)
		default:
			t.Fatalf("unexpected finalize status %d, want 200 or 403", s)
		}
	}
	if !any200 {
		t.Fatalf("no finalize returned 200: %v", statuses)
	}
}

// compile-time assertion the in-memory store satisfies the interface.
var _ acme.Store = (*memStore)(nil)
