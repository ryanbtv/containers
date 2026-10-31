package acme

import (
	"net/http"
	"strings"
)

// allowedBaseDomain is the compiled allowlist. Exactly this domain and any
// subdomain of it may be ordered. Deliberately a constant: this is a
// single-user homelab front for ryanb.tv and nothing else.
const allowedBaseDomain = "ryanb.tv"

// IdentifierError reports why an identifier was rejected, with the ACME
// problem type to return, or nil when the identifier is allowed.
func IdentifierError(id string) *Problem {
	if strings.HasPrefix(id, "*.") || id == "*" {
		return newProblem(problemRejectedIdentifier,
			"wildcard identifiers are not supported", http.StatusBadRequest)
	}
	if id == allowedBaseDomain || strings.HasSuffix(id, "."+allowedBaseDomain) {
		return nil
	}
	return newProblem(problemRejectedIdentifier,
		"identifier is outside the allowed domain "+allowedBaseDomain, http.StatusBadRequest)
}
