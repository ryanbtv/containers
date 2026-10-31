package store

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// PoolCollector exports pgxpool.Stats as pgxpool_* metrics.
type PoolCollector struct {
	pool *pgxpool.Pool
	desc *prometheus.Desc
}

var _ prometheus.Collector = (*PoolCollector)(nil)

// NewPoolCollector builds a scrape-time collector over the pool.
func NewPoolCollector(pool *pgxpool.Pool) *PoolCollector {
	return &PoolCollector{
		pool: pool,
		desc: prometheus.NewDesc("pgxpool_stat",
			"pgxpool connection pool statistics.", []string{"stat"}, nil),
	}
}

// Describe implements prometheus.Collector.
func (c *PoolCollector) Describe(ch chan<- *prometheus.Desc) { ch <- c.desc }

// Collect implements prometheus.Collector.
func (c *PoolCollector) Collect(ch chan<- prometheus.Metric) {
	s := c.pool.Stat()
	add := func(name string, v float64) {
		ch <- prometheus.MustNewConstMetric(c.desc, prometheus.GaugeValue, v, name)
	}
	add("acquire_count", float64(s.AcquireCount()))
	add("acquire_duration_seconds", s.AcquireDuration().Seconds())
	add("acquired_conns", float64(s.AcquiredConns()))
	add("constructing_conns", float64(s.ConstructingConns()))
	add("idle_conns", float64(s.IdleConns()))
	add("max_conns", float64(s.MaxConns()))
	add("total_conns", float64(s.TotalConns()))
	add("new_conns", float64(s.NewConnsCount()))
	add("canceled_acquire_count", float64(s.CanceledAcquireCount()))
	add("empty_acquire_count", float64(s.EmptyAcquireCount()))
	add("empty_acquire_wait_seconds", s.EmptyAcquireWaitTime().Seconds())
	add("max_lifetime_destroy_count", float64(s.MaxLifetimeDestroyCount()))
	add("max_idle_destroy_count", float64(s.MaxIdleDestroyCount()))
}
