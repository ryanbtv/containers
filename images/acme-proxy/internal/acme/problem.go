package acme

import (
	"encoding/json"
	"net/http"
)

// RFC 8555 §6.7 error types.
const (
	problemAccountDoesNotExist = "accountDoesNotExist"
	problemAlreadyRevoked      = "alreadyRevoked"
	problemBadCSR              = "badCSR"
	problemBadNonce            = "badNonce"
	problemBadPublicKey        = "badPublicKey"
	problemBadRevocationReason = "badRevocationReason"
	problemBadSignatureAlgo    = "badSignatureAlgorithm"
	problemConnection          = "connection"
	problemMalformed           = "malformed"
	problemOrderNotReady       = "orderNotReady"
	problemRateLimited         = "rateLimited"
	problemRejectedIdentifier  = "rejectedIdentifier"
	problemServerInternal      = "serverInternal"
	problemUnauthorized        = "unauthorized"
	problemUnknownHost         = "unknownHost"
	problemUnsupportedID       = "unsupportedIdentifier"
)

// Problem is an RFC 8555 §6.7 problem document.
type Problem struct {
	Type        string    `json:"-"` // short form, e.g. "badNonce"
	Detail      string    `json:"-"`
	Status      int       `json:"-"`
	Subproblems []Problem `json:"-"`

	resolved bool
}

func newProblem(typ, detail string, status int) *Problem {
	return &Problem{Type: typ, Detail: detail, Status: status}
}

// Error implements error so problems can travel in error positions.
func (p *Problem) Error() string { return p.Type + ": " + p.Detail }

// AsProblem extracts a *Problem from an error, or wraps it as serverInternal.
func AsProblem(err error) *Problem {
	if p, ok := err.(*Problem); ok && p != nil && p.Type != "" {
		return p
	}
	return newProblem(problemServerInternal, "internal server error", http.StatusInternalServerError)
}

func (p *Problem) MarshalJSON() ([]byte, error) {
	out := map[string]any{
		"type":   "urn:ietf:params:acme:error:" + p.Type,
		"detail": p.Detail,
	}
	if len(p.Subproblems) > 0 {
		out["subproblems"] = p.Subproblems
	}
	return json.Marshal(out)
}
