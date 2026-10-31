package acme

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

type metrics struct {
	registry *prometheus.Registry

	orders       *prometheus.CounterVec // status=valid|invalid at order completion
	certsIssued  prometheus.Counter
	upstreamErr  *prometheus.CounterVec // kind=timeout|upstream|config
	upstreamDur  prometheus.Histogram
	certNotAfter *prometheus.GaugeVec // common_name, serial
}

func newMetrics(reg *prometheus.Registry) *metrics {
	if reg == nil {
		reg = prometheus.NewRegistry()
	}
	m := &metrics{
		registry: reg,
		orders: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "acme_orders_total",
			Help: "Completed ACME orders by final status.",
		}, []string{"status"}),
		certsIssued: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "acme_certificates_issued_total",
			Help: "Certificates obtained from the upstream CA.",
		}),
		upstreamErr: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "acme_upstream_errors_total",
			Help: "Upstream CA issuance failures by kind.",
		}, []string{"kind"}),
		upstreamDur: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "acme_upstream_duration_seconds",
			Help:    "Upstream CA issuance duration, including DNS-01 propagation.",
			Buckets: []float64{5, 15, 30, 60, 90, 120},
		}),
		certNotAfter: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "acme_certificate_not_after_seconds",
			Help: "Expiry of known certificates as a Unix timestamp.",
		}, []string{"common_name", "serial"}),
	}
	reg.MustRegister(
		m.orders, m.certsIssued, m.upstreamErr, m.upstreamDur, m.certNotAfter,
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return m
}

// Registry exposes the registry so main can add the pgx pool collector.
func (m *metrics) Registry() *prometheus.Registry { return m.registry }

// CertNotAfter exposes the gauge so main can seed it from stored certificates.
func (m *metrics) CertNotAfter() *prometheus.GaugeVec { return m.certNotAfter }
