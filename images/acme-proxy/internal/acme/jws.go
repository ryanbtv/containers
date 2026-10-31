package acme

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-jose/go-jose/v4"
)

// signedRequest is a verified ACME POST.
type signedRequest struct {
	Payload json.RawMessage // raw JWS payload bytes; empty for POST-as-GET
	Nonce   string
	// Account is nil only for a newAccount request in JWK form. For every
	// other request the kid must name a valid account, so it is non-nil.
	Account *Account
	// JWK is the JWK from the protected header in JWK form, else nil.
	JWK *jose.JSONWebKey
	// Thumbprint is the RFC 7638 SHA-256 thumbprint of whichever key signed
	// the request.
	Thumbprint string

	// verifyKey is the public key matching whichever of jwk/kid signed the
	// request, resolved during verification.
	verifyKey any
}

var allowedAlgs = []jose.SignatureAlgorithm{jose.ES256, jose.RS256}

// verifyJWS parses and cryptographically verifies a detached-protected JWS
// POST body. It does NOT consume the nonce; the caller does that against the
// store so single-use semantics are shared across replicas.
//
// Enforced per RFC 8555 §6.2: exactly one signature, ES256 or RS256, jwk XOR
// kid, and the url header equal to the request URL (ignoring a trailing
// slash). In kid form the account must exist and be valid.
func (s *Server) verifyJWS(ctx context.Context, r *http.Request, body []byte) (*signedRequest, *Problem) {
	obj, err := jose.ParseSignedJSON(string(body), allowedAlgs)
	if err != nil {
		// ParseSignedJSON already rejects signatures whose alg is not in
		// allowedAlgs, so an unsupported algorithm surfaces here as this
		// problem too.
		return nil, newProblem(problemMalformed, "request body is not an accepted JWS: "+err.Error(), http.StatusBadRequest)
	}
	if len(obj.Signatures) != 1 {
		return nil, newProblem(problemMalformed, "JWS must carry exactly one signature", http.StatusBadRequest)
	}
	hdr := obj.Signatures[0].Protected
	if !slicesContains(allowedAlgs, jose.SignatureAlgorithm(hdr.Algorithm)) {
		return nil, newProblem(problemBadSignatureAlgo,
			hdr.Algorithm+" is not one of the allowed algorithms ES256, RS256", http.StatusBadRequest)
	}
	if (hdr.JSONWebKey != nil) == (hdr.KeyID != "") {
		return nil, newProblem(problemMalformed, "protected header must carry jwk XOR kid", http.StatusBadRequest)
	}
	urlHeader, _ := hdr.ExtraHeaders[jose.HeaderKey("url")].(string)
	want := normalizeURL(requestURL(r))
	if urlHeader == "" || normalizeURL(urlHeader) != want {
		return nil, newProblem(problemMalformed,
			"url header "+urlHeader+" does not match request URL "+want, http.StatusBadRequest)
	}
	if hdr.Nonce == "" {
		return nil, newProblem(problemBadNonce, "Replay-Nonce header missing from JWS", http.StatusBadRequest)
	}

	out := &signedRequest{Nonce: hdr.Nonce}

	if hdr.JSONWebKey != nil {
		if err := checkJWK(hdr.JSONWebKey); err != nil {
			return nil, err
		}
		tp, err := Thumbprint(hdr.JSONWebKey)
		if err != nil {
			return nil, newProblem(problemBadPublicKey, "cannot compute JWK thumbprint", http.StatusBadRequest)
		}
		out.JWK = hdr.JSONWebKey
		out.Thumbprint = tp
		out.verifyKey = signingPublicKey(out)
	} else {
		idStr := strings.TrimPrefix(hdr.KeyID, baseURL(r)+"/acme/account/")
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil || id <= 0 {
			return nil, newProblem(problemMalformed, "kid is not an account URL of this server", http.StatusBadRequest)
		}
		acc, ok, err := s.store.AccountByID(ctx, id)
		if err != nil {
			return nil, AsProblem(err)
		}
		if !ok {
			return nil, newProblem(problemAccountDoesNotExist, "account does not exist", http.StatusForbidden)
		}
		if acc.Status != "valid" {
			return nil, newProblem(problemUnauthorized, "account is "+acc.Status, http.StatusUnauthorized)
		}
		key, err := parseJWK(acc.JWK)
		if err != nil {
			return nil, newProblem(problemServerInternal, "stored account key is corrupt", http.StatusInternalServerError)
		}
		tp, err := Thumbprint(key)
		if err != nil {
			return nil, newProblem(problemServerInternal, "stored account key is corrupt", http.StatusInternalServerError)
		}
		out.Account = &acc
		out.Thumbprint = tp
		out.verifyKey = key.Key
	}

	payload, err := obj.Verify(out.verifyKey)
	if err != nil {
		return nil, newProblem(problemMalformed, "JWS signature verification failed", http.StatusBadRequest)
	}
	out.Payload = payload
	return out, nil
}

func signingPublicKey(req *signedRequest) any {
	switch k := req.JWK.Key.(type) {
	case *ecdsa.PublicKey:
		return k
	case *rsa.PublicKey:
		return k
	default:
		return req.JWK.Key
	}
}

// checkJWK accepts ES256 (P-256) and RS256 (RSA >= 2048) public keys only.
func checkJWK(k *jose.JSONWebKey) *Problem {
	switch pub := k.Key.(type) {
	case *ecdsa.PublicKey:
		if pub.Curve != nil && pub.Curve.Params().Name == "P-256" {
			return nil
		}
		return newProblem(problemBadSignatureAlgo, "only P-256 is supported for EC keys", http.StatusBadRequest)
	case *rsa.PublicKey:
		if pub.N.BitLen() >= 2048 {
			return nil
		}
		return newProblem(problemBadPublicKey, "RSA keys must be at least 2048 bits", http.StatusBadRequest)
	default:
		return newProblem(problemBadSignatureAlgo, "key type must be EC (P-256) or RSA", http.StatusBadRequest)
	}
}

// Thumbprint returns the RFC 7638 SHA-256 JWK thumbprint, base64url-encoded.
func Thumbprint(k *jose.JSONWebKey) (string, error) {
	d, err := k.Thumbprint(crypto.SHA256)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(d), nil
}

// parseJWK unmarshals a stored public JWK.
func parseJWK(raw []byte) (*jose.JSONWebKey, error) {
	var k jose.JSONWebKey
	if err := k.UnmarshalJSON(raw); err != nil {
		return nil, fmt.Errorf("stored JWK: %w", err)
	}
	return &k, nil
}

// publicJWK marshals the public half of a JWK, for storage.
func publicJWK(k *jose.JSONWebKey) (json.RawMessage, error) {
	raw, err := jose.JSONWebKey{Key: signingPublicKey(&signedRequest{JWK: k}), Algorithm: k.Algorithm, KeyID: k.KeyID}.MarshalJSON()
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// isPOSTAsGET reports whether a payload is the empty string (or empty JSON
// object), which RFC 8555 §6.3 defines as a read request.
func isPOSTAsGET(payload json.RawMessage) bool {
	s := strings.TrimSpace(string(payload))
	return s == "" || s == "{}" || s == "null"
}

// normalizeURL strips one or more trailing slashes for comparison.
func normalizeURL(u string) string { return strings.TrimRight(u, "/") }

func slicesContains[T comparable](s []T, v T) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
