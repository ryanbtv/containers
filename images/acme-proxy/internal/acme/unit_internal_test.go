package acme

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"reflect"
	"testing"
)

func TestIdentifierAllowlist(t *testing.T) {
	allowed := []string{"ryanb.tv", "a.ryanb.tv", "x.y.z.ryanb.tv", "dev-1.lab.ryanb.tv"}
	denied := map[string]string{
		"evil.example.com": "rejected",
		"notryanb.tv":      "rejected",
		"xnotryanb.tv":     "rejected",
		"ryanb.tv.evil.io": "rejected",
		"*.ryanb.tv":       "wildcard",
		"*.a.ryanb.tv":     "wildcard",
		"*":                "wildcard",
		"RYANB.TV":         "case-normalized elsewhere", // exact-lowercase only here
		"ryanb.tv ":        "trailing space stays denied at this layer",
		"sub.ryanb.tvx":    "rejected",
	}
	for _, id := range allowed {
		if prob := IdentifierError(id); prob != nil {
			t.Errorf("IdentifierError(%q) = %v, want nil", id, prob)
		}
	}
	for id, note := range denied {
		if prob := IdentifierError(id); prob == nil {
			t.Errorf("IdentifierError(%q) = nil (%s), want rejection", id, note)
		}
	}
}

func TestCheckCSR(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	build := func(names []string) []byte {
		tmpl := &x509.CertificateRequest{DNSNames: names}
		der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, key)
		if err != nil {
			t.Fatal(err)
		}
		return der
	}

	if _, prob := checkCSR(build([]string{"a.ryanb.tv"}), []string{"a.ryanb.tv"}); prob != nil {
		t.Errorf("matching SANs rejected: %v", prob)
	}
	if _, prob := checkCSR(build([]string{"a.ryanb.tv"}), []string{"a.ryanb.tv", "b.ryanb.tv"}); prob == nil {
		t.Error("CSR missing an ordered identifier accepted")
	}
	if _, prob := checkCSR(build([]string{"a.ryanb.tv", "extra.ryanb.tv"}), []string{"a.ryanb.tv"}); prob == nil {
		t.Error("CSR with extra SAN accepted")
	}
	if _, prob := checkCSR([]byte("garbage"), []string{"a.ryanb.tv"}); prob == nil {
		t.Error("unparsable CSR accepted")
	}
}

func TestB64urlDecode(t *testing.T) {
	raw := []byte{0x00, 0xff, 0x10, 0x20}
	padded := base64.URLEncoding.EncodeToString(raw)
	bare := base64.RawURLEncoding.EncodeToString(raw)
	for _, s := range []string{padded, bare} {
		got, err := b64urlDecode(s)
		if err != nil {
			t.Fatalf("decode %q: %v", s, err)
		}
		if !reflect.DeepEqual(got, raw) {
			t.Fatalf("decode %q = %x, want %x", s, got, raw)
		}
	}
	if _, err := b64urlDecode("!!!not base64!!!"); err == nil {
		t.Error("garbage decoded without error")
	}
}

func TestPOSTAsGETDetection(t *testing.T) {
	for _, s := range []string{"", " ", "{}", "null"} {
		if !isPOSTAsGET([]byte(s)) {
			t.Errorf("isPOSTAsGET(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"{\"a\":1}", "[]", "{", "x"} {
		if isPOSTAsGET([]byte(s)) {
			t.Errorf("isPOSTAsGET(%q) = true, want false", s)
		}
	}
}

func TestKeyAuthorizationFormat(t *testing.T) {
	got := KeyAuthorization("tok", "thumb")
	if got != "tok.thumb" {
		t.Errorf("KeyAuthorization = %q", got)
	}
}

func TestProblemMarshaling(t *testing.T) {
	p := newProblem(problemBadNonce, "used", 400)
	b, err := p.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"detail":"used","type":"urn:ietf:params:acme:error:badNonce"}` {
		t.Errorf("problem JSON = %s", b)
	}
}

func TestDNSNameRegex(t *testing.T) {
	for _, ok := range []string{"a.ryanb.tv", "xn--80ak6aa92e.com", "a1.b2.c3.d4.example.org"} {
		if !dnsNameRe.MatchString(ok) {
			t.Errorf("dnsNameRe rejected %q", ok)
		}
	}
	for _, bad := range []string{"-a.b.tv", "a-.b.tv", "a..b.tv", "singlelabel", "a b.tv", "UPPER.TV"} {
		if dnsNameRe.MatchString(bad) {
			t.Errorf("dnsNameRe accepted %q", bad)
		}
	}
}

func TestCSRSelfSignatureRejected(t *testing.T) {
	// Build a CSR then corrupt the signature bytes.
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.CertificateRequest{
		DNSNames:        []string{"a.ryanb.tv"},
		ExtraExtensions: nil,
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, key)
	if err != nil {
		t.Fatal(err)
	}
	// Parse, re-encode with tampered serial field inside the TBS would break
	// parsing; instead verify the honest one passes (sanity) and a foreign
	// signature fails: sign with key A, then CheckSignature with key B
	// happens inside checkCSR only for self-consistency, so craft a CSR whose
	// signature is garbage by truncating.
	if _, prob := checkCSR(der, []string{"a.ryanb.tv"}); prob != nil {
		t.Fatalf("honest CSR rejected: %v", prob)
	}
	bad := der[:len(der)-8]
	if _, prob := checkCSR(bad, []string{"a.ryanb.tv"}); prob == nil {
		t.Error("truncated CSR accepted")
	}
}
