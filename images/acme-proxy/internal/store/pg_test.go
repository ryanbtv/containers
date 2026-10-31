package store

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type pgPoolAlias = pgxpool.Pool

func newPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	return pgxpool.New(ctx, dsn)
}

func mustPool(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	p, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

func pgDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("PG_TEST_DSN")
	if dsn == "" {
		t.Skip("PG_TEST_DSN is NOT SET — Postgres-backed store tests SKIPPED. " +
			"Point it at a scratch Postgres (docker postgres:17-alpine) to run them.")
	}
	return dsn
}

// freshDB creates a disposable database next to the DSN database.
func freshDB(t *testing.T, baseDSN string) string {
	t.Helper()
	name := fmt.Sprintf("acme_store_%d", time.Now().UnixNano()%1e9)
	base, err := url.Parse(baseDSN)
	if err != nil {
		t.Fatal(err)
	}
	maint := *base
	maint.Path = "/postgres"
	pool, err := newPool(context.Background(), maint.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), "CREATE DATABASE "+name); err != nil {
		t.Fatalf("CREATE DATABASE: %v", err)
	}
	t.Cleanup(func() {
		p2, err := newPool(context.Background(), maint.String())
		if err == nil {
			_, _ = p2.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
			p2.Close()
		}
	})
	out := *base
	out.Path = "/" + name
	return out.String()
}

// TestMigrateRace races two startup migrations against a fresh database,
// exactly the replica-boot scenario the advisory lock exists for.
func TestMigrateRace(t *testing.T) {
	ctx := context.Background()
	dsn := freshDB(t, pgDSN(t))

	poolA, err := newPool(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer poolA.Close()
	poolB, err := newPool(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer poolB.Close()

	var wg sync.WaitGroup
	errs := make([]error, 2)
	start := make(chan struct{})
	for i, p := range []*pgPoolAlias{poolA, poolB} {
		wg.Add(1)
		go func(i int, p *pgPoolAlias) {
			defer wg.Done()
			<-start
			errs[i] = Migrate(ctx, p)
		}(i, p)
	}
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("migrator %d: %v", i, err)
		}
	}

	var count int
	if err := poolA.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("schema_migrations rows = %d, want exactly 1", count)
	}
	// Re-running is a clean no-op.
	if err := Migrate(ctx, poolA); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
}

// TestNoncesAcrossPools proves the single-use guarantee is shared across
// separate pools (replicas) over one database.
func TestNoncesAcrossPools(t *testing.T) {
	ctx := context.Background()
	dsn := freshDB(t, pgDSN(t))
	if err := Migrate(ctx, mustPool(t, dsn)); err != nil {
		t.Fatal(err)
	}

	dbA, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer dbA.Close()
	dbB, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer dbB.Close()

	nonce, err := dbA.NewNonce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := dbB.ConsumeNonce(ctx, nonce) // replica B consumes A's nonce
	if err != nil || !ok {
		t.Fatalf("cross-pool consume = %v %v, want true", ok, err)
	}
	ok, err = dbA.ConsumeNonce(ctx, nonce) // replay anywhere fails
	if err != nil || ok {
		t.Fatalf("replay consume = %v %v, want false", ok, err)
	}
	// Unknown nonce fails.
	if ok, err := dbA.ConsumeNonce(ctx, "not-a-real-nonce"); err != nil || ok {
		t.Fatalf("unknown nonce = %v %v, want false", ok, err)
	}
	// Expired nonce fails: backdate the row.
	n2, err := dbA.NewNonce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dbA.pool.Exec(ctx,
		"UPDATE acme_nonces SET issued_at = now() - interval '1 hour' WHERE nonce=$1", n2); err != nil {
		t.Fatal(err)
	}
	if ok, err := dbB.ConsumeNonce(ctx, n2); err != nil || ok {
		t.Fatalf("expired nonce = %v %v, want false", ok, err)
	}
}

// TestSetOrderProcessingExclusive proves the ready → processing transition
// admits exactly one winner across pools, which is what keeps concurrent
// finalize POSTs on separate replicas from double-issuing upstream.
func TestSetOrderProcessingExclusive(t *testing.T) {
	ctx := context.Background()
	dsn := freshDB(t, pgDSN(t))
	dbA, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer dbA.Close()
	dbB, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer dbB.Close()

	if err := Migrate(ctx, mustPool(t, dsn)); err != nil {
		t.Fatal(err)
	}
	// Seed a valid account row for the order's foreign key.
	var accID int64
	if err := dbA.pool.QueryRow(ctx, `
		INSERT INTO acme_accounts(jwk, thumbprint) VALUES ('{}'::jsonb, 'tp-race')
		RETURNING id`).Scan(&accID); err != nil {
		t.Fatal(err)
	}
	order, _, err := dbA.CreateOrder(ctx, accID, []string{"x.ryanb.tv"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dbA.CompleteValidation(ctx, mustAuthzID(t, dbA, order.ID), true, nil); err != nil {
		t.Fatal(err)
	}

	const racers = 8
	results := make([]bool, racers)
	errs := make([]error, racers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range racers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			pool := dbA
			if i%2 == 1 {
				pool = dbB
			}
			results[i], errs[i] = pool.SetOrderProcessing(ctx, order.ID)
		}(i)
	}
	close(start)
	wg.Wait()

	winners := 0
	for i, err := range errs {
		if err != nil {
			t.Fatalf("racer %d: %v", i, err)
		}
		if results[i] {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("SetOrderProcessing winners = %d, want exactly 1", winners)
	}
}

func mustAuthzID(t *testing.T, db *DB, orderID int64) int64 {
	t.Helper()
	authzs, err := db.AuthzByOrder(context.Background(), orderID)
	if err != nil || len(authzs) != 1 {
		t.Fatalf("authzs = %v, %v", authzs, err)
	}
	return authzs[0].ID
}

// TestKVSetIfAbsentRace is the upstream account key boot race.
func TestKVSetIfAbsentRace(t *testing.T) {
	ctx := context.Background()
	dsn := freshDB(t, pgDSN(t))
	if err := Migrate(ctx, mustPool(t, dsn)); err != nil {
		t.Fatal(err)
	}
	db, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	vals := make([][]byte, 6)
	errs := make([]error, 6)
	var wg sync.WaitGroup
	for i := range vals {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			vals[i], errs[i] = db.KVSetIfAbsent(ctx, "shared", []byte(fmt.Sprintf("v%d", i)))
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("writer %d: %v", i, err)
		}
	}
	// All six callers converge on the same stored value.
	for i := range vals {
		if string(vals[i]) != string(vals[0]) {
			t.Fatalf("writer %d got %q, writer 0 got %q", i, vals[i], vals[0])
		}
	}
	stored, err := db.KVGet(ctx, "shared")
	if err != nil || !strings.HasPrefix(string(stored), "v") {
		t.Fatalf("KVGet = %q %v", stored, err)
	}
	missing, err := db.KVGet(ctx, "absent")
	if err != nil || missing != nil {
		t.Fatalf("KVGet absent = %q %v, want nil", missing, err)
	}
}
