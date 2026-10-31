package upstream

import (
	"context"
	"testing"
	"time"
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
