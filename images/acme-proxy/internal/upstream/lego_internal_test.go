package upstream

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"net"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-acme/lego/v5/challenge/dns01"
	"github.com/miekg/dns"
)

// ctxSpyProvider records the state of the context CleanUp sees DURING the
// call (the wrapper cancels it on return, so post-return inspection would
// always show canceled).
type ctxSpyProvider struct {
	cleanupWasLive bool
	cleanupHadDead bool
	presentCalls   int
}

func (s *ctxSpyProvider) Present(context.Context, string, string, string) error {
	s.presentCalls++
	return nil
}

func (s *ctxSpyProvider) CleanUp(ctx context.Context, _, _, _ string) error {
	s.cleanupWasLive = ctx.Err() == nil
	_, s.cleanupHadDead = ctx.Deadline()
	return nil
}

func (s *ctxSpyProvider) Timeout() (time.Duration, time.Duration) {
	return time.Minute, time.Second
}

// TestDNSCleanupProviderSurvivesCancellation is the regression for stale
// Cloudflare TXT records: lego calls CleanUp with the (possibly canceled)
// issuance context; the wrapper must hand the provider a live, bounded one.
func TestDNSCleanupProviderSurvivesCancellation(t *testing.T) {
	spy := &ctxSpyProvider{}
	p := dnsCleanupProvider{spy}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // issuance deadline fired / client disconnected

	if err := p.CleanUp(ctx, "_acme-challenge.a.ryanb.tv", "tok", "ka"); err != nil {
		t.Fatalf("CleanUp with canceled ctx: %v", err)
	}
	if !spy.cleanupWasLive {
		t.Error("provider saw a canceled context; cleanup would have failed")
	}
	if !spy.cleanupHadDead {
		t.Error("cleanup context has no bound")
	}

	// Present and Timeout pass through untouched.
	if err := p.Present(context.Background(), "d", "t", "k"); err != nil {
		t.Fatal(err)
	}
	if spy.presentCalls != 1 {
		t.Error("Present not delegated")
	}
	to, iv := p.Timeout()
	if to != time.Minute || iv != time.Second {
		t.Errorf("Timeout = %v/%v, want pass-through", to, iv)
	}
}

// TestDNS01NameserversDefault pins the compiled-in resolver list. In lego
// v5 a non-empty Options.RecursiveNameservers is itself the
// "nameservers-only" switch (internal.NewClient reads /etc/resolv.conf
// ONLY when the list is empty), so asserting this exact list asserts the
// v4-era RecursiveNameservers + RecursiveNameserversOnly=true semantics:
// the Cloudflare provider's SOA zone walk can no longer see the homelab's
// internal BIND.
func TestDNS01NameserversDefault(t *testing.T) {
	t.Setenv(dns01NameserversEnv, "")
	got := dns01Nameservers(os.Getenv(dns01NameserversEnv))
	want := []string{"adam.ns.cloudflare.com:53", "betty.ns.cloudflare.com:53"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("dns01Nameservers(default) = %q, want %q", got, want)
	}
}

func TestDNS01NameserversEnvOverride(t *testing.T) {
	got := dns01Nameservers("ns1.example.com:5353, ns2.example.com ,")
	want := []string{"ns1.example.com:5353", "ns2.example.com:53"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("dns01Nameservers(env) = %q, want %q", got, want)
	}
}

// TestDNS01NameserversNeverEmpty guards the silent-regression path: lego
// falls back to /etc/resolv.conf when the list is empty, so a junk env
// value must still produce the pinned defaults.
func TestDNS01NameserversNeverEmpty(t *testing.T) {
	got := dns01Nameservers(" , ,, ")
	if len(got) == 0 || got[0] != "adam.ns.cloudflare.com:53" {
		t.Errorf("dns01Nameservers(junk) = %q, want pinned defaults", got)
	}
}

// TestNewLegoIssuerPinsDNS01Resolver proves the wiring end to end,
// hermetically: with ACME_DNS01_NAMESERVERS pointed at a loopback DNS
// server, NewLegoIssuer must swap lego's process-wide DNS-01 client so
// the SOA zone walk lands on that server (answer: example.com.), never on
// the system resolver.
func TestNewLegoIssuerPinsDNS01Resolver(t *testing.T) {
	prev := dns01.DefaultClient()
	t.Cleanup(func() { dns01.SetDefaultClient(prev) })

	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan string, 16)
	go func() {
		buf := make([]byte, 65535)
		for {
			n, src, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			var q dns.Msg
			if err := q.Unpack(buf[:n]); err != nil || len(q.Question) == 0 {
				continue
			}
			served <- strings.ToLower(q.Question[0].Name)
			m := new(dns.Msg).SetReply(&q)
			if dns.IsSubDomain("example.com.", strings.ToLower(q.Question[0].Name)) {
				soa, err := dns.NewRR("example.com. 10 IN SOA ns.example.com. hostmaster.example.com. 1 7200 3600 1209600 10")
				if err == nil {
					m.Answer = append(m.Answer, soa)
				}
			}
			if b, err := m.Pack(); err == nil {
				_, _ = pc.WriteTo(b, src)
			}
		}
	}()
	t.Cleanup(func() { _ = pc.Close() })

	t.Setenv(dns01NameserversEnv, pc.LocalAddr().String())
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = NewLegoIssuer("", "irrelevant-token", key)

	if dns01.DefaultClient() == prev {
		t.Fatal("NewLegoIssuer did not replace lego's default DNS-01 client")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	zone, err := dns01.DefaultClient().FindZoneByFqdn(ctx, "_acme-challenge.app.example.com.")
	if err != nil {
		t.Fatalf("FindZoneByFqdn via installed client: %v", err)
	}
	if zone != "example.com." {
		t.Errorf("discovered zone = %q, want %q", zone, "example.com.")
	}
	// The walk must have reached the loopback nameserver, not the system one.
	if len(served) == 0 {
		t.Error("loopback nameserver answered no queries; system resolver still in play")
	}
}
