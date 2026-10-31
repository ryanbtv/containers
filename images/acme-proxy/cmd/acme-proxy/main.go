// Command acme-proxy is an ACME server (RFC 8555) for internal machines:
// clients point their standard ACME clients at it, it validates their
// http-01 challenges over the internal network, obtains a real Let's
// Encrypt certificate upstream via DNS-01 through Cloudflare, and hands
// back a chain for the client's own key. See images/acme-proxy/README.md.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ryanbtv/containers/images/acme-proxy/internal/acme"
	"github.com/ryanbtv/containers/images/acme-proxy/internal/store"
	"github.com/ryanbtv/containers/images/acme-proxy/internal/upstream"
)

// Configuration is exactly these four variables; the allowed-domain
// allowlist (ryanb.tv) is compiled in.
//
//	DATABASE_URL                 Postgres DSN (required)
//	CLOUDFLARE_DNS_API_TOKEN     Cloudflare API token with DNS:edit (required to issue)
//	ACME_UPSTREAM_DIRECTORY_URL  optional; defaults to the Let's Encrypt prod directory
//	LISTEN_ADDR                  optional; default ":8080"
func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	if err := run(logger); err != nil {
		logger.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}
	listenAddr := os.Getenv("LISTEN_ADDR")
	if listenAddr == "" {
		listenAddr = ":8080"
	}
	caDirURL := os.Getenv("ACME_UPSTREAM_DIRECTORY_URL")
	if caDirURL == "" {
		caDirURL = upstream.DefaultCADirectoryURL
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := store.New(ctx, dsn)
	if err != nil {
		return err
	}
	defer db.Close()

	if err := store.Migrate(ctx, db.Pool()); err != nil {
		return err
	}

	accountKey, created, err := upstream.EnsureAccountKey(ctx, db)
	if err != nil {
		return err
	}
	logger.Info("upstream ACME account key ready", "generated", created)

	issuer := upstream.NewLegoIssuer(caDirURL, os.Getenv("CLOUDFLARE_DNS_API_TOKEN"), accountKey)

	handler, err := acme.NewHandler(acme.Config{
		Store:  db,
		Issuer: issuer,
	})
	if err != nil {
		return err
	}
	if err := handler.Registry().Register(store.NewPoolCollector(db.Pool())); err != nil {
		return err
	}
	if err := handler.SeedCertificateGauges(ctx); err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", listenAddr, "upstream", caDirURL)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
