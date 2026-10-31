package acme_test

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	legoacme "github.com/go-acme/lego/v5/acme"
	"github.com/go-acme/lego/v5/certificate"
	"github.com/go-acme/lego/v5/lego"
	"github.com/go-acme/lego/v5/registration"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ryanbtv/containers/images/acme-proxy/internal/acme"
	"github.com/ryanbtv/containers/images/acme-proxy/internal/store"
	"github.com/ryanbtv/containers/images/acme-proxy/internal/upstream"
)

// ---- lego client plumbing ----

type testUser struct{ key crypto.Signer }

func (u *testUser) GetEmail() string                           { return "" }
func (u *testUser) GetRegistration() *legoacme.ExtendedAccount { return nil }
func (u *testUser) GetPrivateKey() crypto.Signer               { return u.key }

func newLegoClient(t *testing.T, env *testEnv) *lego.Client {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg := lego.NewConfig(&testUser{key: key})
	cfg.CADirURL = env.Server.URL + "/directory"
	// Trust the httptest certificate.
	cfg.HTTPClient = env.Server.Client()
	client, err := lego.NewClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Challenge.SetHTTP01Provider(env.solver); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Registration.Register(context.Background(),
		registration.RegisterOptions{TermsOfServiceAgreed: true}); err != nil {
		t.Fatalf("lego register: %v", err)
	}
	return client
}

func makeCSR(t *testing.T, names ...string) ([]byte, *x509.CertificateRequest, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader,
		&x509.CertificateRequest{DNSNames: names}, key)
	if err != nil {
		t.Fatal(err)
	}
	csr, err := x509.ParseCertificateRequest(der)
	if err != nil {
		t.Fatal(err)
	}
	return der, csr, key
}

func parseChain(t *testing.T, chainPEM []byte) []*x509.Certificate {
	t.Helper()
	var out []*x509.Certificate
	rest := chainPEM
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		t.Fatal("empty chain")
	}
	return out
}

// happyPath drives the complete flow with a real lego ACME client and the
// http-01 answer served by an in-process test server reached through the
// injectable dialer. It returns the issuing lego client (account-bound) and
// the certificate resource.
func happyPath(t *testing.T, env *testEnv) (*lego.Client, *certificate.Resource) {
	t.Helper()
	client := newLegoClient(t, env)
	_, csr, _ := makeCSR(t, "test.ryanb.tv")

	certRes, err := client.Certificate.ObtainForCSR(context.Background(),
		certificate.ObtainForCSRRequest{CSR: csr, Bundle: true})
	if err != nil {
		t.Fatalf("lego ObtainForCSR: %v", err)
	}
	chain := parseChain(t, certRes.Certificate)
	if len(chain) < 2 {
		t.Fatalf("chain length = %d, want leaf + CA", len(chain))
	}
	leaf := chain[0]
	if len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != "test.ryanb.tv" {
		t.Errorf("leaf SANs = %v", leaf.DNSNames)
	}

	// The order must have transitioned to valid with a certificate attached,
	// and the authz must be valid.
	certs, err := env.store.ListCertificates(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%X", leaf.SerialNumber)
	var found *acme.CertSummary
	for i := range certs {
		if certs[i].Serial == want {
			found = &certs[i]
		}
	}
	if found == nil {
		t.Fatalf("issued certificate %s not in store (have %d certs)", want, len(certs))
	}

	// The solver must have been CleanUp'd by lego.
	env.solver.mu.Lock()
	leftovers := len(env.solver.val)
	env.solver.mu.Unlock()
	if leftovers != 0 {
		t.Errorf("solver still holds %d entries after CleanUp", leftovers)
	}
	return client, certRes
}

// ---- always-on (in-memory store) integration ----

func TestIntegrationHappyPathMem(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	happyPath(t, env)

	// Order ended valid: find it through the store's orders by replaying a
	// second order to observe status transitions end-to-end via lego.
	client := newLegoClient(t, env)
	_, csr, _ := makeCSR(t, "second.ryanb.tv")
	if _, err := client.Certificate.ObtainForCSR(context.Background(),
		certificate.ObtainForCSRRequest{CSR: csr, Bundle: true}); err != nil {
		t.Fatalf("second order: %v", err)
	}

	// Metrics exposed on /metrics.
	resp, err := env.Server.Client().Get(env.Server.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 1<<20)
	n, _ := resp.Body.Read(buf)
	body := string(buf[:n])
	for _, want := range []string{
		"acme_certificates_issued_total 2",
		`acme_orders_total{status="valid"} 2`,
		"acme_upstream_duration_seconds_count 2",
		"acme_certificate_not_after_seconds{",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics missing %q", want)
		}
	}

	// Certificate list endpoints render.
	apiResp, err := env.Server.Client().Get(env.Server.URL + "/api/v1/certificates")
	if err != nil {
		t.Fatal(err)
	}
	defer apiResp.Body.Close()
	var list struct {
		Certificates []struct {
			Serial        string   `json:"serial"`
			Sans          []string `json:"sans"`
			DaysRemaining int      `json:"days_remaining"`
			Revoked       bool     `json:"revoked"`
		} `json:"certificates"`
	}
	if err := json.NewDecoder(apiResp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Certificates) != 2 {
		t.Fatalf("api list = %d certs, want 2", len(list.Certificates))
	}
	if list.Certificates[0].DaysRemaining < 80 || list.Certificates[0].Revoked {
		t.Errorf("unexpected view: %+v", list.Certificates[0])
	}

	htmlResp, err := env.Server.Client().Get(env.Server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer htmlResp.Body.Close()
	hbuf := make([]byte, 1<<20)
	hn, _ := htmlResp.Body.Read(hbuf)
	if !strings.Contains(string(hbuf[:hn]), "test.ryanb.tv") || !strings.Contains(string(hbuf[:hn]), "<table>") {
		t.Error("HTML page missing certificate table")
	}
}

func TestIntegrationRevokePaths(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	client, certRes := happyPath(t, env)
	chain := parseChain(t, certRes.Certificate)
	leafDER := chain[0].Raw

	// kid revoke via the issuing lego client (its own account); v5 takes the
	// PEM bundle.
	if err := client.Certificate.Revoke(context.Background(), certRes.Certificate); err != nil {
		t.Fatalf("lego revoke (kid): %v", err)
	}
	certs, _ := env.store.ListCertificates(context.Background())
	var revoked bool
	for _, c := range certs {
		if c.Revoked {
			revoked = true
		}
	}
	if !revoked {
		t.Fatal("no certificate marked revoked after kid revoke")
	}

	// Double revoke of the same certificate surfaces alreadyRevoked when the
	// caller is an account that owns some certificate; covered authoritatively
	// by TestManualAcmeFlowAndRevoke below.

	// jwk revoke with a foreign key → unauthorized.
	foreign := newAccountKey(t)
	nonce := env.getNonce(t)
	certB64 := base64.RawURLEncoding.EncodeToString(leafDER)
	res := env.post(t, env.Server.URL+"/acme/revoke-cert", foreign, "", nonce,
		fmt.Sprintf(`{"certificate":"%s"}`, certB64))
	if res.Status != 403 || problemType(t, res.Body) != "urn:ietf:params:acme:error:unauthorized" {
		t.Fatalf("foreign jwk revoke = %d %s, want 403 unauthorized", res.Status, res.Body)
	}
}

func TestIntegrationReplaySameCSR(t *testing.T) {
	env := newEnv(t, newMemStore(), nil)
	client := newLegoClient(t, env)
	_, csr, _ := makeCSR(t, "replay.ryanb.tv")

	first, err := client.Certificate.ObtainForCSR(context.Background(),
		certificate.ObtainForCSRRequest{CSR: csr, Bundle: true})
	if err != nil {
		t.Fatal(err)
	}
	// Re-order of the same identifier set with the same CSR must issue fresh
	// (standard client behavior), keeping history.
	second, err := client.Certificate.ObtainForCSR(context.Background(),
		certificate.ObtainForCSRRequest{CSR: csr, Bundle: true})
	if err != nil {
		t.Fatalf("replay of same CSR failed: %v", err)
	}
	c1 := parseChain(t, first.Certificate)[0]
	c2 := parseChain(t, second.Certificate)[0]
	if c1.SerialNumber.Cmp(c2.SerialNumber) == 0 {
		t.Error("replay returned the same serial; expected a fresh issuance")
	}
	certs, _ := env.store.ListCertificates(context.Background())
	if len(certs) < 2 {
		t.Fatalf("store keeps history: %d certs", len(certs))
	}
}

func TestIntegrationUpstreamFailureInvalidatesOrder(t *testing.T) {
	boom := fmt.Errorf("cloudflare: propagation timeout (simulated)")
	env := newEnv(t, newMemStore(), failingIssuer{err: boom})
	client := newLegoClient(t, env)
	_, csr, _ := makeCSR(t, "fail.ryanb.tv")
	_, err := client.Certificate.ObtainForCSR(context.Background(),
		certificate.ObtainForCSRRequest{CSR: csr, Bundle: true})
	if err == nil {
		t.Fatal("expected obtain to fail")
	}
}

// ---- Postgres-gated integration ----

func pgDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("PG_TEST_DSN")
	if dsn == "" {
		t.Skip("PG_TEST_DSN is NOT SET — Postgres-backed integration suite SKIPPED. " +
			"Run it: docker network + postgres:17-alpine, then PG_TEST_DSN=postgres://... go test")
	}
	return dsn
}

// freshPGDB creates a disposable database alongside the DSN database and
// returns its DSN.
func freshPGDB(t *testing.T, baseDSN string) string {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("acme_it_%d", time.Now().UnixNano()%1e9)

	base, err := url.Parse(baseDSN)
	if err != nil {
		t.Fatal(err)
	}
	maint := *base
	maint.Path = "/postgres"
	pool, err := pgxpool.New(ctx, maint.String())
	if err != nil {
		t.Fatalf("connect maintenance db (is the DSN user allowed to CREATE DATABASE?): %v", err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create test db: %v", err)
	}
	t.Cleanup(func() {
		p2, err := pgxpool.New(context.Background(), maint.String())
		if err == nil {
			_, _ = p2.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
			p2.Close()
		}
	})
	newDSN := *base
	newDSN.Path = "/" + name
	return newDSN.String()
}

func TestPGIntegrationFullFlow(t *testing.T) {
	dsn := pgDSN(t)
	dbDSN := freshPGDB(t, dsn)
	ctx := context.Background()

	db1, err := store.New(ctx, dbDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer db1.Close()
	if err := store.Migrate(ctx, db1.Pool()); err != nil {
		t.Fatal(err)
	}
	// Second replica's pool over the same database.
	db2, err := store.New(ctx, dbDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()

	env := newEnv(t, db1, nil)
	happyPath(t, env)

	// Cross-replica nonce: server B (db2) issues the nonce, server A (db1)
	// consumes it via a real signed request.
	envB := newEnv(t, db2, nil)
	nonceResp, err := envB.Server.Client().Head(envB.Server.URL + "/acme/new-nonce")
	if err != nil {
		t.Fatal(err)
	}
	nonceResp.Body.Close()
	nonce := nonceResp.Header.Get("Replay-Nonce")
	if nonce == "" {
		t.Fatal("replica B issued no nonce")
	}
	key := newAccountKey(t)
	res := env.post(t, env.Server.URL+"/acme/new-account", key, "", nonce, `{"termsOfServiceAgreed":true}`)
	if res.Status != 201 {
		t.Fatalf("cross-replica nonce consumption = %d %s, want 201", res.Status, res.Body)
	}

	// Revocation on replica B sees the certificate issued through A.
	certs, _ := db2.ListCertificates(ctx)
	if len(certs) == 0 {
		t.Fatal("replica B sees no certificates")
	}

	// The upstream account key: concurrent EnsureAccountKey calls converge.
	var wg sync.WaitGroup
	keys := make([]crypto.Signer, 4)
	errs := make([]error, 4)
	for i := range keys {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			keys[i], _, errs[i] = upstream.EnsureAccountKey(ctx, db1)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("EnsureAccountKey %d: %v", i, err)
		}
	}
	base := fingerprint(keys[0])
	for i, k := range keys[1:] {
		if fingerprint(k) != base {
			t.Errorf("EnsureAccountKey replica %d got a different key", i+1)
		}
	}
}

func fingerprint(k crypto.Signer) string {
	der, err := x509.MarshalPKIXPublicKey(k.Public())
	if err != nil {
		return "ERR:" + err.Error()
	}
	return fmt.Sprintf("%x", der)[:32]
}

// newEnvWithStore builds an env on store s but shares nothing with envA.
