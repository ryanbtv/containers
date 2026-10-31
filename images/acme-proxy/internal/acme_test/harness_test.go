// Package acme_test drives the ACME front end-to-end. The Postgres-backed
// cases gate on PG_TEST_DSN; everything else runs hermetically with an
// in-memory store (unit scope only — the integration suite proper uses real
// Postgres and is skipped loudly without PG_TEST_DSN).
package acme_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/ryanbtv/containers/images/acme-proxy/internal/acme"
)

// ---- in-memory store: unit-test scaffolding only ----

type memStore struct {
	mu       sync.Mutex
	nonces   map[string]bool
	accounts map[int64]acme.Account
	accByTP  map[string]int64
	orders   map[int64]acme.Order
	authzs   map[int64]acme.Authz
	authzOrd map[int64][]int64
	certs    map[int64]memCert
	nextID   int64
}

type memCert struct {
	rec  acme.CertRecord
	acc  int64
	rev  *time.Time
	rwho *int
}

func newMemStore() *memStore {
	return &memStore{
		nonces: map[string]bool{}, accounts: map[int64]acme.Account{}, accByTP: map[string]int64{},
		orders: map[int64]acme.Order{}, authzs: map[int64]acme.Authz{}, authzOrd: map[int64][]int64{},
		certs: map[int64]memCert{},
	}
}

func (m *memStore) next() int64 { m.nextID++; return m.nextID }

func (m *memStore) NewNonce(context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := fmt.Sprintf("n-%d", m.next())
	m.nonces[n] = true
	return n, nil
}

func (m *memStore) ConsumeNonce(_ context.Context, n string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.nonces[n] {
		delete(m.nonces, n)
		return true, nil
	}
	return false, nil
}

func (m *memStore) CreateAccount(_ context.Context, jwk json.RawMessage, tp string, contact []string) (acme.Account, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.accByTP[tp]; ok {
		return m.accounts[id], false, nil
	}
	a := acme.Account{ID: m.next(), JWK: jwk, Thumbprint: tp, Status: "valid", Contact: contact, CreatedAt: time.Now()}
	m.accounts[a.ID] = a
	m.accByTP[tp] = a.ID
	return a, true, nil
}

func (m *memStore) AccountByThumbprint(_ context.Context, tp string) (acme.Account, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.accByTP[tp]
	if !ok {
		return acme.Account{}, false, nil
	}
	return m.accounts[id], true, nil
}

func (m *memStore) AccountByID(_ context.Context, id int64) (acme.Account, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	return a, ok, nil
}

func (m *memStore) SetAccountStatus(_ context.Context, id int64, status string) (acme.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a := m.accounts[id]
	a.Status = status
	m.accounts[id] = a
	return a, nil
}

func (m *memStore) SetAccountContact(_ context.Context, id int64, contact []string) (acme.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a := m.accounts[id]
	a.Contact = contact
	m.accounts[id] = a
	return a, nil
}

func (m *memStore) CreateOrder(_ context.Context, accountID int64, ids []string) (acme.Order, []acme.Authz, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o := acme.Order{ID: m.next(), AccountID: accountID, Identifiers: ids, Status: "pending",
		ExpiresAt: time.Now().Add(7 * 24 * time.Hour), CreatedAt: time.Now()}
	m.orders[o.ID] = o
	var authzs []acme.Authz
	for _, id := range ids {
		a := acme.Authz{ID: m.next(), OrderID: o.ID, Identifier: id,
			Token: fmt.Sprintf("tok%d", m.next()), Status: "pending", CreatedAt: time.Now()}
		m.authzs[a.ID] = a
		m.authzOrd[o.ID] = append(m.authzOrd[o.ID], a.ID)
		authzs = append(authzs, a)
	}
	return o, authzs, nil
}

func (m *memStore) OrderByID(_ context.Context, id int64) (acme.Order, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.orders[id]
	return o, ok, nil
}

func (m *memStore) AuthzByOrder(_ context.Context, orderID int64) ([]acme.Authz, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []acme.Authz
	for _, id := range m.authzOrd[orderID] {
		out = append(out, m.authzs[id])
	}
	return out, nil
}

func (m *memStore) AuthzByID(_ context.Context, id int64) (acme.Authz, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.authzs[id]
	return a, ok, nil
}

func (m *memStore) CompleteValidation(_ context.Context, authzID int64, valid bool, problem *acme.Problem) (acme.Authz, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a := m.authzs[authzID]
	if valid {
		a.Status = "valid"
	} else {
		a.Status = "invalid"
		if problem != nil {
			b, _ := json.Marshal(problem)
			a.Error = b
		}
	}
	now := time.Now()
	a.ValidatedAt = &now
	m.authzs[authzID] = a

	o := m.orders[a.OrderID]
	if o.Status != "pending" {
		return a, nil
	}
	if !valid {
		o.Status = "invalid"
		if problem != nil {
			b, _ := json.Marshal(problem)
			o.Error = b
		}
	} else {
		allValid := true
		for _, id := range m.authzOrd[a.OrderID] {
			if m.authzs[id].Status != "valid" {
				allValid = false
			}
		}
		if allValid {
			o.Status = "ready"
		}
	}
	m.orders[a.OrderID] = o
	return a, nil
}

func (m *memStore) SetOrderProcessing(_ context.Context, orderID int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o := m.orders[orderID]
	if o.Status != "ready" {
		return false, nil
	}
	o.Status = "processing"
	m.orders[orderID] = o
	return true, nil
}

func (m *memStore) CompleteOrder(_ context.Context, orderID, certificateID int64) (acme.Order, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o := m.orders[orderID]
	o.Status = "valid"
	o.CertificateID = certificateID
	m.orders[orderID] = o
	return o, nil
}

func (m *memStore) FailOrder(_ context.Context, orderID int64, problem *acme.Problem) (acme.Order, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o := m.orders[orderID]
	o.Status = "invalid"
	if problem != nil {
		b, _ := json.Marshal(problem)
		o.Error = b
	}
	m.orders[orderID] = o
	return o, nil
}

func (m *memStore) SaveCertificate(_ context.Context, accountID, orderID int64, rec acme.CertRecord) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, dup := m.certsBySerialLocked(rec.Serial); dup != 0 {
		return 0, fmt.Errorf("duplicate serial %s", rec.Serial)
	}
	id := m.next()
	m.certs[id] = memCert{rec: rec, acc: accountID}
	return id, nil
}

func (m *memStore) certsBySerialLocked(serial string) (memCert, int64) {
	for id, c := range m.certs {
		if c.rec.Serial == serial {
			return c, id
		}
	}
	return memCert{}, 0
}

func (m *memStore) CertificateByID(_ context.Context, id int64) (acme.CertRecord, int64, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.certs[id]
	return c.rec, c.acc, ok, nil
}

func (m *memStore) CertificateBySerial(_ context.Context, serial, aki string) (acme.CertRecord, int64, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, id := m.certsBySerialLocked(serial)
	if id == 0 || (aki != "" && c.rec.AKI != aki) {
		return acme.CertRecord{}, 0, false, nil
	}
	return c.rec, c.acc, true, nil
}

func (m *memStore) RevokeCertificate(_ context.Context, serial, aki string, reason int) (acme.CertRecord, int64, bool, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, id := m.certsBySerialLocked(serial)
	if id == 0 || (aki != "" && c.rec.AKI != aki) {
		return acme.CertRecord{}, 0, false, false, nil
	}
	if c.rev != nil {
		return c.rec, c.acc, true, true, nil
	}
	now := time.Now()
	c.rev = &now
	c.rwho = &reason
	m.certs[id] = c
	return c.rec, c.acc, true, false, nil
}

func (m *memStore) ListCertificates(context.Context) ([]acme.CertSummary, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []acme.CertSummary
	for _, c := range m.certs {
		s := acme.CertSummary{
			Serial: c.rec.Serial, AKI: c.rec.AKI, CommonName: c.rec.CommonName,
			Sans: c.rec.Sans, NotBefore: c.rec.NotBefore, NotAfter: c.rec.NotAfter,
			Revoked: c.rev != nil, RevokedAt: c.rev, RevokeReason: c.rwho,
		}
		if acc, ok := m.accounts[c.acc]; ok {
			s.AccountThumbprint = acc.Thumbprint
		}
		out = append(out, s)
	}
	return out, nil
}

// ---- fake upstream CA ----

// testCA signs fake leaf certificates so the whole flow runs hermetically.
type testCA struct {
	cert    *x509.Certificate
	key     *ecdsa.PrivateKey
	serialN int64
}

func newTestCA(t *testing.T) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "acme-proxy test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		SubjectKeyId:          []byte{0xaa, 0xbb, 0xcc},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCA{cert: cert, key: key}
}

func (ca *testCA) Issue(_ context.Context, csrDER []byte, _ []string) ([]byte, error) {
	csr, err := x509.ParseCertificateRequest(csrDER)
	if err != nil {
		return nil, err
	}
	ca.serialN++
	tmpl := &x509.Certificate{
		SerialNumber:   big.NewInt(1000 + ca.serialN),
		Subject:        csr.Subject,
		DNSNames:       csr.DNSNames,
		NotBefore:      time.Now().Add(-time.Hour),
		NotAfter:       time.Now().Add(90 * 24 * time.Hour),
		KeyUsage:       x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:    []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		AuthorityKeyId: ca.cert.SubjectKeyId,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, csr.PublicKey, ca.key)
	if err != nil {
		return nil, err
	}
	leafPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.cert.Raw})
	return append(leafPEM, caPEM...), nil
}

// failingIssuer simulates a slow/broken upstream (deadline or error).
type failingIssuer struct{ err error }

func (f failingIssuer) Issue(ctx context.Context, _ []byte, _ []string) ([]byte, error) {
	return nil, f.err
}

// countingIssuer delegates to a real test CA and counts upstream issuance
// attempts. hold keeps each call inside Issue for a while to widen the race
// window for concurrency tests.
type countingIssuer struct {
	ca    *testCA
	hold  time.Duration
	mu    sync.Mutex
	calls int
}

func (c *countingIssuer) Issue(ctx context.Context, csrDER []byte, ids []string) ([]byte, error) {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
	if c.hold > 0 {
		select {
		case <-time.After(c.hold):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return c.ca.Issue(ctx, csrDER, ids)
}

func (c *countingIssuer) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// ---- challenge solver + dialer plumbing ----

type solver struct {
	mu  sync.Mutex
	val map[string]string // domain/token -> keyAuth
}

func newSolver() *solver { return &solver{val: map[string]string{}} }

func (s *solver) Present(_ context.Context, domain, token, keyAuth string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.val[domain+"/"+token] = keyAuth
	return nil
}

func (s *solver) CleanUp(_ context.Context, domain, token, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.val, domain+"/"+token)
	return nil
}

// ---- environment ----

type testEnv struct {
	t        *testing.T
	Server   *httptest.Server
	solve    *httptest.Server
	solver   *solver
	store    acme.Store
	registry *prometheus.Registry
	ca       *testCA
	handler  *acme.Handler
}

// newEnv starts a full ACME front over the given store. dialTestRoutesAll
// makes http-01 validation dial the in-process solve server for any host.
func newEnv(t *testing.T, store acme.Store, issuer acme.Issuer) *testEnv {
	t.Helper()
	s := newSolver()
	ca := newTestCA(t)
	if issuer == nil {
		issuer = ca
	}

	solve := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.URL.Path, "/.well-known/acme-challenge/")
		s.mu.Lock()
		var v string
		var ok bool
		for k, val := range s.val {
			if strings.HasSuffix(k, "/"+token) {
				v, ok = val, true
				break
			}
		}
		s.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		// Values prefixed REDIRECT: answer with a 302 to the remainder,
		// exercising the validator's redirect policy.
		if target, isRedir := strings.CutPrefix(v, "REDIRECT:"); isRedir {
			http.Redirect(w, r, target, http.StatusFound)
			return
		}
		_, _ = w.Write([]byte(v))
	}))
	t.Cleanup(solve.Close)

	solveAddr := solve.Listener.Addr().(*net.TCPAddr)
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		d := net.Dialer{}
		return d.DialContext(ctx, network, fmt.Sprintf("127.0.0.1:%d", solveAddr.Port))
	}

	reg := prometheus.NewRegistry()
	h, err := acme.NewHandler(acme.Config{Store: store, Issuer: issuer, DialContext: dial, Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	// TLS front: lego v5 requires an https directory URL (RFC 8555 §6.1).
	// Tests use srv.Client(), which trusts the test certificate.
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	return &testEnv{t: t, Server: srv, solve: solve, solver: s, store: store, registry: reg, ca: ca, handler: h}
}

// ---- JWS client helpers ----

func newAccountKey(t *testing.T) jose.JSONWebKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return jose.JSONWebKey{Key: key}
}

// sign builds an ACME JWS with protected headers alg/nonce/url and either
// the embedded jwk or the given kid.
func sign(t *testing.T, key jose.JSONWebKey, payload, url, nonce, kid string) []byte {
	t.Helper()
	alg := jose.ES256
	switch key.Key.(type) {
	case *ecdsa.PrivateKey:
		alg = jose.ES256
	default:
		t.Fatalf("unsupported test key type %T", key.Key)
	}
	opts := jose.SignerOptions{}
	if kid != "" {
		opts = *opts.WithHeader(jose.HeaderKey("kid"), kid)
	} else {
		opts.EmbedJWK = true
	}
	opts = *opts.WithHeader(jose.HeaderKey("url"), url).WithHeader(jose.HeaderKey("nonce"), nonce)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: alg, Key: key}, &opts)
	if err != nil {
		t.Fatal(err)
	}
	obj, err := signer.Sign([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	return []byte(obj.FullSerialize())
}

type postResult struct {
	Status int
	Body   []byte
	Header http.Header
}

// post performs a signed ACME POST and returns the response, capturing the
// Replay-Nonce the server issued for the next request.
func (e *testEnv) post(t *testing.T, url string, key jose.JSONWebKey, kid, nonce, payload string) postResult {
	t.Helper()
	body := sign(t, key, payload, url, nonce, kid)
	resp, err := e.Server.Client().Post(url, "application/jose+json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return postResult{Status: resp.StatusCode, Body: raw, Header: resp.Header}
}

// getNonce fetches a fresh nonce from newNonce (HEAD).
func (e *testEnv) getNonce(t *testing.T) string {
	t.Helper()
	resp, err := e.Server.Client().Head(e.Server.URL + "/acme/new-nonce")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return resp.Header.Get("Replay-Nonce")
}

func problemType(t *testing.T, body []byte) string {
	t.Helper()
	var p map[string]any
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("body is not JSON: %s", body)
	}
	typ, _ := p["type"].(string)
	return typ
}
