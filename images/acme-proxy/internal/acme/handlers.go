package acme

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/prometheus/client_golang/prometheus"
)

// upstreamTimeout bounds one upstream issuance, including DNS-01 propagation.
const upstreamTimeout = 120 * time.Second

// reasonCodesAllowed are the revocation reasons RFC 8555 §7.6 permits for
// requests (0-10 minus keyCompromise(1 handled below), CRL and removeCRL).
var reasonCodesAllowed = map[int]bool{0: true, 1: true, 3: true, 4: true, 5: true, 6: true, 8: true, 9: true}

// readVerified runs the shared POST pipeline: read bounded body, verify JWS,
// consume the nonce exactly once (Postgres-backed, so any replica issued or
// consumed it), and require an account when the endpoint needs one.
func (s *Server) readVerified(w http.ResponseWriter, r *http.Request, requireAccount bool) (*signedRequest, bool) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			s.writeProblem(w, r, newProblem(problemMalformed, "request body too large", http.StatusBadRequest))
		} else {
			s.writeProblem(w, r, newProblem(problemMalformed, "cannot read request body", http.StatusBadRequest))
		}
		return nil, false
	}
	sreq, prob := s.verifyJWS(r.Context(), r, body)
	if prob != nil {
		s.writeProblem(w, r, prob)
		return nil, false
	}
	ok, err := s.store.ConsumeNonce(r.Context(), sreq.Nonce)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return nil, false
	}
	if !ok {
		s.writeProblem(w, r, newProblem(problemBadNonce,
			"JWS nonce was missing, expired, or already used", http.StatusBadRequest))
		return nil, false
	}
	if requireAccount && sreq.Account == nil {
		s.writeProblem(w, r, newProblem(problemAccountDoesNotExist,
			"this endpoint requires an account (kid)", http.StatusForbidden))
		return nil, false
	}
	return sreq, true
}

// ---- directory & nonces ----

func (s *Server) handleDirectory(w http.ResponseWriter, r *http.Request) {
	base := baseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"newNonce":   base + "/acme/new-nonce",
		"newAccount": base + "/acme/new-account",
		"newOrder":   base + "/acme/new-order",
		"revokeCert": base + "/acme/revoke-cert",
		"meta": map[string]any{
			"caaIdentities": []string{"letsencrypt.org"},
		},
		// No keyChange: account key rollover is not implemented. No
		// externalAccountRequired: EAB is not used, and per spec the key
		// must be absent, not false.
	})
}

func (s *Server) handleNewNonce(w http.ResponseWriter, r *http.Request) {
	// Replay-Nonce header was set by the wrapping middleware.
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- accounts ----

func (s *Server) handleNewAccount(w http.ResponseWriter, r *http.Request) {
	sreq, ok := s.readVerified(w, r, false)
	if !ok {
		return
	}
	var payload struct {
		TermsOfServiceAgreed bool     `json:"termsOfServiceAgreed"`
		Contact              []string `json:"contact"`
		OnlyReturnExisting   bool     `json:"onlyReturnExisting"`
	}
	if len(sreq.Payload) > 0 && !isPOSTAsGET(sreq.Payload) {
		if err := json.Unmarshal(sreq.Payload, &payload); err != nil {
			s.writeProblem(w, r, newProblem(problemMalformed, "account payload is not JSON", http.StatusBadRequest))
			return
		}
	}
	ctx := r.Context()

	if sreq.JWK == nil {
		// kid form: account update (RFC 8555 §7.3.5).
		s.updateAccount(w, r, sreq, sreq.Payload)
		return
	}

	// JWK form: look up by thumbprint first; this is what certbot and
	// acme.sh key-rollover pre-checks rely on.
	acc, exists, err := s.store.AccountByThumbprint(ctx, sreq.Thumbprint)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	if exists {
		s.writeAccount(w, r, acc, http.StatusOK)
		return
	}
	if payload.OnlyReturnExisting {
		s.writeProblem(w, r, newProblem(problemAccountDoesNotExist,
			"no account exists for this key", http.StatusForbidden))
		return
	}
	if err := validContacts(payload.Contact); err != nil {
		s.writeProblem(w, r, err)
		return
	}
	pub, err := publicJWK(sreq.JWK)
	if err != nil {
		s.writeProblem(w, r, newProblem(problemBadPublicKey, "cannot canonicalize JWK", http.StatusBadRequest))
		return
	}
	acc, _, err = s.store.CreateAccount(ctx, pub, sreq.Thumbprint, payload.Contact)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	s.writeAccount(w, r, acc, http.StatusCreated)
}

func (s *Server) updateAccount(w http.ResponseWriter, r *http.Request, sreq *signedRequest, payloadRaw []byte) {
	if isPOSTAsGET(payloadRaw) {
		s.writeAccount(w, r, *sreq.Account, http.StatusOK)
		return
	}
	var payload struct {
		Contact *[]string `json:"contact"`
		Status  string    `json:"status"`
	}
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		s.writeProblem(w, r, newProblem(problemMalformed, "account payload is not JSON", http.StatusBadRequest))
		return
	}
	ctx := r.Context()
	acc := *sreq.Account
	var err error

	if payload.Status != "" {
		switch {
		case payload.Status == "deactivated" && acc.Status == "valid":
			acc, err = s.store.SetAccountStatus(ctx, acc.ID, "deactivated")
		case payload.Status == "revoked" && acc.Status == "deactivated":
			acc, err = s.store.SetAccountStatus(ctx, acc.ID, "revoked")
		case payload.Status == acc.Status: // idempotent
		default:
			s.writeProblem(w, r, newProblem(problemUnauthorized,
				"cannot move account from "+acc.Status+" to "+payload.Status, http.StatusUnauthorized))
			return
		}
		if err != nil {
			s.writeProblem(w, r, AsProblem(err))
			return
		}
	}
	if payload.Contact != nil {
		if err := validContacts(*payload.Contact); err != nil {
			s.writeProblem(w, r, err)
			return
		}
		acc, err = s.store.SetAccountContact(ctx, acc.ID, *payload.Contact)
		if err != nil {
			s.writeProblem(w, r, AsProblem(err))
			return
		}
	}
	s.writeAccount(w, r, acc, http.StatusOK)
}

// handleAccount serves POST-as-GET reads, updates, and JWK-form account
// lookups on an account URL.
func (s *Server) handleAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(w, r, "id")
	if !ok {
		return
	}
	sreq, vok := s.readVerified(w, r, false)
	if !vok {
		return
	}
	ctx := r.Context()
	if sreq.JWK != nil {
		// Legacy lookup: the account at this URL, keyed by matching JWK.
		acc, exists, err := s.store.AccountByID(ctx, id)
		if err != nil {
			s.writeProblem(w, r, AsProblem(err))
			return
		}
		if !exists || acc.Thumbprint != sreq.Thumbprint {
			s.writeProblem(w, r, newProblem(problemAccountDoesNotExist,
				"no account at this URL for this key", http.StatusForbidden))
			return
		}
		s.writeAccount(w, r, acc, http.StatusOK)
		return
	}
	if sreq.Account.ID != id {
		s.writeProblem(w, r, newProblem(problemUnauthorized,
			"kid does not match the account in the URL", http.StatusUnauthorized))
		return
	}
	s.updateAccount(w, r, sreq, sreq.Payload)
}

func (s *Server) writeAccount(w http.ResponseWriter, r *http.Request, acc Account, status int) {
	w.Header().Set("Location", baseURL(r)+"/acme/account/"+itoa(acc.ID))
	body := map[string]any{"status": acc.Status}
	if len(acc.Contact) > 0 {
		body["contact"] = acc.Contact
	}
	writeJSON(w, status, body)
}

func validContacts(contact []string) *Problem {
	for _, c := range contact {
		if !strings.HasPrefix(c, "mailto:") {
			return newProblem(problemMalformed, "contact entries must be mailto: URLs", http.StatusBadRequest)
		}
	}
	return nil
}

// ---- orders ----

func (s *Server) handleNewOrder(w http.ResponseWriter, r *http.Request) {
	sreq, ok := s.readVerified(w, r, true)
	if !ok {
		return
	}
	var payload struct {
		Identifiers []struct {
			Type  string `json:"type"`
			Value string `json:"value"`
		} `json:"identifiers"`
		NotBefore string `json:"notBefore"`
		NotAfter  string `json:"notAfter"`
	}
	if isPOSTAsGET(sreq.Payload) || len(sreq.Payload) == 0 {
		s.writeProblem(w, r, newProblem(problemMalformed, "order requires an identifiers array", http.StatusBadRequest))
		return
	}
	if err := json.Unmarshal(sreq.Payload, &payload); err != nil {
		s.writeProblem(w, r, newProblem(problemMalformed, "order payload is not JSON", http.StatusBadRequest))
		return
	}
	for _, ts := range []string{payload.NotBefore, payload.NotAfter} {
		if ts != "" {
			if _, err := time.Parse(time.RFC3339, ts); err != nil {
				s.writeProblem(w, r, newProblem(problemMalformed, "notBefore/notAfter must be RFC3339", http.StatusBadRequest))
				return
			}
			// Accepted and ignored: the upstream CA controls validity.
		}
	}
	if len(payload.Identifiers) == 0 {
		s.writeProblem(w, r, newProblem(problemMalformed, "at least one identifier is required", http.StatusBadRequest))
		return
	}
	ids := make([]string, 0, len(payload.Identifiers))
	for _, id := range payload.Identifiers {
		if id.Type != "dns" {
			s.writeProblem(w, r, newProblem(problemUnsupportedID,
				"identifier type "+id.Type+" is not supported", http.StatusBadRequest))
			return
		}
		value := strings.ToLower(strings.TrimSpace(id.Value))
		if strings.HasPrefix(value, "*.") || value == "*" {
			s.writeProblem(w, r, IdentifierError(value))
			return
		}
		if !dnsNameRe.MatchString(value) || len(value) > 253 {
			s.writeProblem(w, r, newProblem(problemMalformed, "not a valid DNS name: "+id.Value, http.StatusBadRequest))
			return
		}
		if prob := IdentifierError(value); prob != nil {
			s.writeProblem(w, r, prob)
			return
		}
		ids = append(ids, value)
	}
	ids = dedupeSorted(ids)

	order, _, err := s.store.CreateOrder(r.Context(), sreq.Account.ID, ids)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	w.Header().Set("Location", s.orderURL(r, order.ID))
	s.writeOrderStatus(w, r, order, http.StatusCreated)
}

func (s *Server) handleOrder(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(w, r, "id")
	if !ok {
		return
	}
	sreq, ok := s.readVerified(w, r, true)
	if !ok {
		return
	}
	if !isPOSTAsGET(sreq.Payload) {
		s.writeProblem(w, r, newProblem(problemMalformed, "the order endpoint only supports POST-as-GET reads", http.StatusBadRequest))
		return
	}
	order, found, err := s.store.OrderByID(r.Context(), id)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	if !found || order.AccountID != sreq.Account.ID {
		s.writeProblem(w, r, newProblem(problemMalformed, "no such order for this account", http.StatusNotFound))
		return
	}
	s.writeOrder(w, r, order)
}

func (s *Server) writeOrder(w http.ResponseWriter, r *http.Request, order Order) {
	s.writeOrderStatus(w, r, order, http.StatusOK)
}

func (s *Server) writeOrderStatus(w http.ResponseWriter, r *http.Request, order Order, status int) {
	base := baseURL(r)
	ids := make([]map[string]string, 0, len(order.Identifiers))
	for _, id := range order.Identifiers {
		ids = append(ids, map[string]string{"type": "dns", "value": id})
	}
	body := map[string]any{
		"status":      order.Status,
		"expires":     order.ExpiresAt.UTC().Format(time.RFC3339),
		"identifiers": ids,
		"finalize":    s.orderURL(r, order.ID) + "/finalize",
	}
	if len(order.Error) > 0 {
		body["error"] = json.RawMessage(order.Error)
	}
	authzs, err := s.store.AuthzByOrder(r.Context(), order.ID)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	urls := make([]string, 0, len(authzs))
	for _, a := range authzs {
		urls = append(urls, s.authzURL(r, a.ID))
	}
	body["authorizations"] = urls
	if order.CertificateID != 0 {
		body["certificate"] = base + "/acme/certificate/" + itoa(order.CertificateID)
	}
	writeJSON(w, status, body)
}

func (s *Server) orderURL(r *http.Request, id int64) string {
	return baseURL(r) + "/acme/order/" + itoa(id)
}
func (s *Server) authzURL(r *http.Request, id int64) string {
	return baseURL(r) + "/acme/authz/" + itoa(id)
}
func (s *Server) challengeURL(r *http.Request, authzID int64) string {
	// Exactly one challenge per authorization (http-01), so challenge id 1.
	return baseURL(r) + "/acme/challenge/" + itoa(authzID) + "/1"
}

// ---- authorizations & challenges ----

func (s *Server) handleAuthz(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(w, r, "id")
	if !ok {
		return
	}
	sreq, ok := s.readVerified(w, r, true)
	if !ok {
		return
	}
	if !isPOSTAsGET(sreq.Payload) {
		s.writeProblem(w, r, newProblem(problemMalformed, "the authorization endpoint only supports POST-as-GET reads", http.StatusBadRequest))
		return
	}
	authz, order, _, prob := s.authzWithOrder(r.Context(), id, sreq.Account.ID)
	if prob != nil {
		s.writeProblem(w, r, prob)
		return
	}
	body := map[string]any{
		"identifier": map[string]string{"type": "dns", "value": authz.Identifier},
		"status":     authz.Status,
		"expires":    order.ExpiresAt.UTC().Format(time.RFC3339),
		"challenges": []map[string]any{s.challengeJSON(r, authz)},
	}
	if len(authz.Error) > 0 {
		body["error"] = json.RawMessage(authz.Error)
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) authzWithOrder(ctx context.Context, authzID, accountID int64) (Authz, Order, bool, *Problem) {
	authz, found, err := s.store.AuthzByID(ctx, authzID)
	if err != nil {
		return Authz{}, Order{}, false, AsProblem(err)
	}
	if !found {
		return Authz{}, Order{}, false, newProblem(problemMalformed, "no such authorization", http.StatusNotFound)
	}
	order, found, err := s.store.OrderByID(ctx, authz.OrderID)
	if err != nil {
		return Authz{}, Order{}, false, AsProblem(err)
	}
	if !found || order.AccountID != accountID {
		return Authz{}, Order{}, false, newProblem(problemMalformed, "no such authorization for this account", http.StatusNotFound)
	}
	return authz, order, true, nil
}

func (s *Server) challengeJSON(r *http.Request, authz Authz) map[string]any {
	// RFC 8555 defines no status on Challenge objects, but Boulder (and
	// therefore clients like lego and cert-manager) expect the validation
	// state echoed there.
	return map[string]any{
		"type":   "http-01",
		"url":    s.challengeURL(r, authz.ID),
		"token":  authz.Token,
		"status": authz.Status,
	}
}

// handleChallenge triggers http-01 validation. Validation runs
// synchronously; the challenge object is returned as-is per RFC 8555 §8.3 —
// the outcome is visible on the authorization.
func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	authzID, ok := pathInt64(w, r, "authzID")
	if !ok {
		return
	}
	if chID := r.PathValue("challengeID"); chID != "1" {
		s.writeProblem(w, r, newProblem(problemMalformed, "unknown challenge id", http.StatusNotFound))
		return
	}
	sreq, ok := s.readVerified(w, r, true)
	if !ok {
		return
	}
	ctx := r.Context()
	authz, _, _, prob := s.authzWithOrder(ctx, authzID, sreq.Account.ID)
	if prob != nil {
		s.writeProblem(w, r, prob)
		return
	}

	if authz.Status != "pending" {
		// Already decided; re-validation is not repeated.
		writeJSON(w, http.StatusOK, s.challengeJSON(r, authz))
		return
	}

	keyAuth := KeyAuthorization(authz.Token, sreq.Account.Thumbprint)
	vprob := s.validate.Validate(ctx, authz.Identifier, authz.Token, keyAuth)
	updated, err := s.store.CompleteValidation(ctx, authz.ID, vprob == nil, vprob)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	if updated.Status == "invalid" {
		s.metrics.orders.WithLabelValues("invalid").Inc()
	}
	writeJSON(w, http.StatusOK, s.challengeJSON(r, updated))
}

// ---- finalize & certificates ----

func (s *Server) handleFinalize(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(w, r, "id")
	if !ok {
		return
	}
	sreq, ok := s.readVerified(w, r, true)
	if !ok {
		return
	}
	ctx := r.Context()
	order, found, err := s.store.OrderByID(ctx, id)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	if !found || order.AccountID != sreq.Account.ID {
		s.writeProblem(w, r, newProblem(problemMalformed, "no such order for this account", http.StatusNotFound))
		return
	}
	switch order.Status {
	case "valid":
		s.writeOrder(w, r, order) // idempotent replay of finalize
		return
	case "ready":
		// proceed
	default: // pending, processing, invalid
		s.writeProblem(w, r, newProblem(problemOrderNotReady,
			"order status is "+order.Status, http.StatusForbidden))
		return
	}

	var payload struct {
		CSR string `json:"csr"`
	}
	if err := json.Unmarshal(sreq.Payload, &payload); err != nil || payload.CSR == "" {
		s.writeProblem(w, r, newProblem(problemMalformed, "finalize requires a csr", http.StatusBadRequest))
		return
	}
	csrDER, err := b64urlDecode(payload.CSR)
	if err != nil {
		s.writeProblem(w, r, newProblem(problemBadCSR, "csr is not valid base64url", http.StatusBadRequest))
		return
	}
	if _, prob := checkCSR(csrDER, order.Identifiers); prob != nil {
		s.writeProblem(w, r, prob)
		return
	}

	// Deliberate design: upstream issuance happens synchronously inside
	// finalize. The order is briefly processing; the response below already
	// carries valid+certificate (or the order ends invalid). RFC §7.4 says
	// finalize answers 200, so we return 200 rather than 201 even though the
	// order is complete: strict clients (x/crypto-derived ACME clients such
	// as cert-manager) assert exactly 200 here.
	// Atomically claim the order: the ready → processing transition happens
	// in one conditional UPDATE, so concurrent finalize POSTs cannot both
	// reach the upstream issuer.
	transitioned, err := s.store.SetOrderProcessing(ctx, order.ID)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	if !transitioned {
		// Another finalize claimed it first (or it moved on since the read
		// above). If that one completed, replay the finished order;
		// otherwise tell this client to poll.
		cur, found, err := s.store.OrderByID(ctx, order.ID)
		if err != nil {
			s.writeProblem(w, r, AsProblem(err))
			return
		}
		if found && cur.Status == "valid" {
			s.writeOrder(w, r, cur)
			return
		}
		s.writeProblem(w, r, newProblem(problemOrderNotReady,
			"order is already being finalized", http.StatusForbidden))
		return
	}

	issueCtx, cancel := context.WithTimeout(ctx, upstreamTimeout)
	defer cancel()
	start := time.Now()
	chainPEM, issueErr := s.issuer.Issue(issueCtx, csrDER, order.Identifiers)
	s.metrics.upstreamDur.Observe(time.Since(start).Seconds())

	if issueErr != nil {
		kind := "upstream"
		if errors.Is(issueErr, context.DeadlineExceeded) {
			kind = "timeout"
		}
		s.metrics.upstreamErr.WithLabelValues(kind).Inc()
		prob := newProblem(problemServerInternal,
			"upstream issuance failed: "+issueErr.Error(), http.StatusInternalServerError)
		if _, ferr := s.store.FailOrder(ctx, order.ID, prob); ferr != nil {
			s.logger.Error("FailOrder after upstream failure", "order", order.ID, "err", ferr)
		}
		s.metrics.orders.WithLabelValues("invalid").Inc()
		s.writeProblem(w, r, prob)
		return
	}

	leaf, err := leafFromChain(chainPEM)
	if err != nil {
		prob := newProblem(problemServerInternal, "upstream returned an unparsable chain", http.StatusInternalServerError)
		if _, ferr := s.store.FailOrder(ctx, order.ID, prob); ferr != nil {
			s.logger.Error("FailOrder after unparsable chain", "order", order.ID, "err", ferr)
		}
		s.metrics.upstreamErr.WithLabelValues("upstream").Inc()
		s.metrics.orders.WithLabelValues("invalid").Inc()
		s.writeProblem(w, r, prob)
		return
	}

	rec := CertRecord{
		Serial:     strings.ToUpper(leaf.SerialNumber.Text(16)),
		AKI:        hex.EncodeToString(leaf.AuthorityKeyId),
		CommonName: leaf.Subject.CommonName,
		DER:        leaf.Raw,
		ChainPEM:   chainPEM,
		Sans:       lowerCopy(leaf.DNSNames),
		NotBefore:  leaf.NotBefore,
		NotAfter:   leaf.NotAfter,
	}
	certID, err := s.store.SaveCertificate(ctx, sreq.Account.ID, order.ID, rec)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	order, err = s.store.CompleteOrder(ctx, order.ID, certID)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	s.metrics.orders.WithLabelValues("valid").Inc()
	s.metrics.certsIssued.Inc()
	s.metrics.certNotAfter.WithLabelValues(rec.CommonName, rec.Serial).Set(float64(rec.NotAfter.Unix()))
	s.writeOrder(w, r, order)
}

// checkCSR parses a client CSR and enforces SANs == order identifiers.
func checkCSR(der []byte, identifiers []string) (*x509.CertificateRequest, *Problem) {
	csr, err := x509.ParseCertificateRequest(der)
	if err != nil {
		return nil, newProblem(problemBadCSR, "cannot parse CSR: "+err.Error(), http.StatusBadRequest)
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, newProblem(problemBadCSR, "CSR self-signature is invalid", http.StatusBadRequest)
	}
	if len(csr.IPAddresses) > 0 || len(csr.EmailAddresses) > 0 || len(csr.URIs) > 0 {
		return nil, newProblem(problemBadCSR, "only DNS names are allowed in the CSR", http.StatusBadRequest)
	}
	sans := dedupeSorted(lowerCopy(csr.DNSNames))
	if !equalSets(sans, identifiers) {
		return nil, newProblem(problemBadCSR,
			"CSR SANs do not exactly match the order identifiers", http.StatusBadRequest)
	}
	return csr, nil
}

func leafFromChain(chainPEM []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(chainPEM)
	if block == nil {
		return nil, errors.New("no PEM block in chain")
	}
	return x509.ParseCertificate(block.Bytes)
}

func (s *Server) handleCertificate(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(w, r, "id")
	if !ok {
		return
	}
	sreq, ok := s.readVerified(w, r, true)
	if !ok {
		return
	}
	if !isPOSTAsGET(sreq.Payload) {
		s.writeProblem(w, r, newProblem(problemMalformed, "the certificate endpoint only supports POST-as-GET reads", http.StatusBadRequest))
		return
	}
	rec, accountID, found, err := s.store.CertificateByID(r.Context(), id)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	if !found {
		s.writeProblem(w, r, newProblem(problemMalformed, "no such certificate", http.StatusNotFound))
		return
	}
	if accountID != sreq.Account.ID {
		s.writeProblem(w, r, newProblem(problemUnauthorized, "certificate belongs to another account", http.StatusForbidden))
		return
	}
	w.Header().Set("Content-Type", "application/pem-certificate-chain")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(rec.ChainPEM)
}

// ---- revocation ----

func (s *Server) handleRevokeCert(w http.ResponseWriter, r *http.Request) {
	sreq, ok := s.readVerified(w, r, false)
	if !ok {
		return
	}
	var payload struct {
		Certificate string `json:"certificate"`
		Reason      *int   `json:"reason"`
	}
	if err := json.Unmarshal(sreq.Payload, &payload); err != nil || payload.Certificate == "" {
		s.writeProblem(w, r, newProblem(problemMalformed, "revoke requires a certificate", http.StatusBadRequest))
		return
	}
	if payload.Reason != nil && !reasonCodesAllowed[*payload.Reason] {
		s.writeProblem(w, r, newProblem(problemBadRevocationReason,
			"reason code is not allowed for revocation requests", http.StatusBadRequest))
		return
	}
	der, err := b64urlDecode(payload.Certificate)
	if err != nil {
		s.writeProblem(w, r, newProblem(problemMalformed, "certificate is not valid base64url", http.StatusBadRequest))
		return
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		s.writeProblem(w, r, newProblem(problemMalformed, "cannot parse certificate", http.StatusBadRequest))
		return
	}
	ctx := r.Context()
	serial := strings.ToUpper(cert.SerialNumber.Text(16))
	aki := hex.EncodeToString(cert.AuthorityKeyId)

	// RFC 8555 §7.6: the signing key MUST be verified as authorized BEFORE
	// the certificate is revoked. Look the certificate up read-only,
	// authorize, and only then mutate state.
	rec, certAccountID, found, err := s.store.CertificateBySerial(ctx, serial, aki)
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	if !found {
		s.writeProblem(w, r, newProblem(problemMalformed, "no certificate managed by this server has that serial", http.StatusNotFound))
		return
	}
	if prob := s.authorizeRevocation(ctx, sreq, cert, certAccountID); prob != nil {
		s.writeProblem(w, r, prob)
		return
	}

	_, _, _, already, err := s.store.RevokeCertificate(ctx, serial, aki, derefInt(payload.Reason))
	if err != nil {
		s.writeProblem(w, r, AsProblem(err))
		return
	}
	if already {
		s.writeProblem(w, r, newProblem(problemAlreadyRevoked, "certificate is already revoked", http.StatusForbidden))
		return
	}
	s.metrics.certNotAfter.Delete(prometheus.Labels{"common_name": rec.CommonName, "serial": rec.Serial})
	w.WriteHeader(http.StatusOK)
}

// authorizeRevocation accepts kid auth from the owning account, and jwk auth
// from either the owning account key or the certificate's own public key
// (RFC 8555 §7.6).
func (s *Server) authorizeRevocation(ctx context.Context, sreq *signedRequest, cert *x509.Certificate, certAccountID int64) *Problem {
	if sreq.Account != nil {
		if sreq.Account.ID == certAccountID {
			return nil
		}
		return newProblem(problemUnauthorized, "account does not own this certificate", http.StatusForbidden)
	}
	if owner, found, err := s.store.AccountByID(ctx, certAccountID); err == nil && found &&
		owner.Thumbprint == sreq.Thumbprint {
		return nil
	}
	certJWK := &jose.JSONWebKey{Key: cert.PublicKey}
	tp, err := Thumbprint(certJWK)
	if err == nil && tp == sreq.Thumbprint {
		return nil
	}
	return newProblem(problemUnauthorized,
		"jwk must be the issuing account key or the certificate's own key", http.StatusForbidden)
}

// ---- health ----

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if p, ok := s.store.(interface {
		Ping(context.Context) error
	}); ok {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := p.Ping(ctx); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("database unavailable\n"))
			return
		}
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok\n"))
}

// ---- small helpers ----

func pathInt64(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	n, err := parseInt64(r.PathValue(key))
	if err != nil {
		http.NotFound(w, r)
		return 0, false
	}
	return n, true
}

func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func lowerCopy(in []string) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = strings.ToLower(v)
	}
	return out
}

func dedupeSorted(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

func equalSets(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func b64urlDecode(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	out, err := base64.RawURLEncoding.DecodeString(s)
	if err == nil {
		return out, nil
	}
	// Some clients emit base64url with padding.
	return base64.URLEncoding.DecodeString(s + paddingFor(len(s)%4))
}

func paddingFor(rem int) string {
	switch rem {
	case 2:
		return "=="
	case 3:
		return "="
	default:
		return ""
	}
}
