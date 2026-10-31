package acme

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Issuer obtains a certificate chain from the upstream ACME CA. Production
// uses go-acme/lego with Cloudflare DNS-01; tests substitute a fake.
type Issuer interface {
	// Issue takes a client CSR in DER form plus the order identifiers it was
	// checked against, and returns the full chain PEM (leaf first).
	Issue(ctx context.Context, csrDER []byte, identifiers []string) (chainPEM []byte, err error)
}

// Config wires a Server.
type Config struct {
	Store  Store
	Issuer Issuer
	// DialContext overrides dialing for http-01 validation traffic only.
	DialContext func(ctx context.Context, network, addr string) (net.Conn, error)
	Registry    *prometheus.Registry
	Logger      *slog.Logger
}

// Server is the ACME front plus its observability endpoints. It serves plain
// HTTP; TLS terminates upstream (Traefik). Absolute URLs in responses honor
// X-Forwarded-Proto and X-Forwarded-Host so the public URL renders as
// https://acme.sff.k8s.ryanb.tv behind the proxy.
type Server struct {
	store    Store
	issuer   Issuer
	validate *HTTP01Validator
	metrics  *metrics
	logger   *slog.Logger
}

// Handler is the routed server plus the handles main needs (metrics
// registry, expiry-gauge seeding).
type Handler struct {
	http.Handler
	metrics *metrics
	store   Store
}

// Registry returns the Prometheus registry so main can add the pgx pool
// collector before serving.
func (h *Handler) Registry() *prometheus.Registry { return h.metrics.registry }

// SeedCertificateGauges loads existing unexpired, unrevoked certificates
// into acme_certificate_not_after_seconds at startup.
func (h *Handler) SeedCertificateGauges(ctx context.Context) error {
	certs, err := h.store.ListCertificates(ctx)
	if err != nil {
		return err
	}
	for _, c := range certs {
		if c.Revoked {
			continue
		}
		h.metrics.certNotAfter.WithLabelValues(c.CommonName, c.Serial).
			Set(float64(c.NotAfter.Unix()))
	}
	return nil
}

// NewHandler returns the fully routed HTTP handler.
func NewHandler(cfg Config) (*Handler, error) {
	s := &Server{
		store:  cfg.Store,
		issuer: cfg.Issuer,
		validate: &HTTP01Validator{
			DialContext: cfg.DialContext,
		},
		metrics: newMetrics(cfg.Registry),
		logger:  cfg.Logger,
	}
	if s.logger == nil {
		s.logger = slog.Default()
	}

	mux := http.NewServeMux()

	// ACME directory (plain GET only, RFC 8555 §7.4).
	mux.HandleFunc("GET /.well-known/acme-directory", s.handleDirectory)
	mux.HandleFunc("GET /directory", s.handleDirectory)

	// Nonces.
	mux.HandleFunc("GET /acme/new-nonce", s.handleNewNonce)

	// Account / order / challenge flow.
	mux.HandleFunc("POST /acme/new-account", s.handleNewAccount)
	mux.HandleFunc("POST /acme/new-order", s.handleNewOrder)
	mux.HandleFunc("POST /acme/revoke-cert", s.handleRevokeCert)
	mux.HandleFunc("POST /acme/account/{id}", s.handleAccount)
	mux.HandleFunc("POST /acme/order/{id}", s.handleOrder)
	mux.HandleFunc("POST /acme/order/{id}/finalize", s.handleFinalize)
	mux.HandleFunc("POST /acme/authz/{id}", s.handleAuthz)
	mux.HandleFunc("POST /acme/challenge/{authzID}/{challengeID}", s.handleChallenge)
	mux.HandleFunc("POST /acme/certificate/{id}", s.handleCertificate)

	// Observability and read-only UI (internal-only ingress, no auth).
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.metrics.registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /api/v1/certificates", s.handleAPICertificates)
	mux.HandleFunc("GET /{$}", s.handleIndex)

	return &Handler{Handler: s.wrap(mux), metrics: s.metrics, store: cfg.Store}, nil
}

// wrap adds access logging, then nonce issuance and body limits on ACME
// paths.
func (s *Server) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusWriter{ResponseWriter: w}
		defer func(start time.Time) {
			if r.URL.Path == "/healthz" {
				s.logger.Debug("http", "method", r.Method, "path", r.URL.Path,
					"status", rec.status, "dur_ms", time.Since(start).Milliseconds())
				return
			}
			s.logger.Info("http", "method", r.Method, "path", r.URL.Path,
				"status", rec.status, "dur_ms", time.Since(start).Milliseconds())
		}(time.Now())

		if !strings.HasPrefix(r.URL.Path, "/acme/") &&
			!strings.HasPrefix(r.URL.Path, "/.well-known/acme") {
			next.ServeHTTP(rec, r)
			return
		}

		// Every ACME response carries a Replay-Nonce, error responses
		// included, so clients can always retry (RFC 8555 §6.5, §6.6).
		nonce, err := s.store.NewNonce(r.Context())
		if err != nil {
			s.writeProblem(rec, r, newProblem(problemServerInternal, "nonce store unavailable", http.StatusInternalServerError))
			return
		}
		rec.Header().Set("Replay-Nonce", nonce)
		rec.Header().Set("Cache-Control", "no-store")

		if r.Method == http.MethodPost {
			r.Body = http.MaxBytesReader(rec, r.Body, maxPOSTBody)
		}
		next.ServeHTTP(rec, r)
	})
}

// statusWriter records the response code for access logging.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

// Write records the implicit 200 for handlers that never call WriteHeader.
func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// maxPOSTBody bounds request bodies. ACME POSTs carry a JWS with at most a
// small CSR or certificate; 1 MiB is generous.
const maxPOSTBody = 1 << 20

// ---- URL reconstruction (X-Forwarded-Proto / X-Forwarded-Host aware) ----

func forwardedOr(req *http.Request, header, fallback string) string {
	if v := req.Header.Get(header); v != "" {
		// Take the first hop of a comma list.
		if i := strings.IndexByte(v, ','); i >= 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	return fallback
}

// baseURL returns scheme://host as the client-facing front is known by.
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	scheme = forwardedOr(r, "X-Forwarded-Proto", scheme)
	host := forwardedOr(r, "X-Forwarded-Host", r.Host)
	return scheme + "://" + host
}

// requestURL rebuilds the absolute URL the client addressed, for JWS url
// header comparison.
func requestURL(r *http.Request) string {
	u := baseURL(r) + r.URL.Path
	if r.URL.RawQuery != "" {
		u += "?" + r.URL.RawQuery
	}
	return u
}

// ---- JSON helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = jsonEncoder(w).Encode(v)
}

func (s *Server) writeProblem(w http.ResponseWriter, r *http.Request, p *Problem) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Link", "<"+baseURL(r)+"/directory>;rel=\"index\"")
	status := p.Status
	if status == 0 {
		status = http.StatusInternalServerError
	}
	w.WriteHeader(status)
	_ = jsonEncoder(w).Encode(p)
}
