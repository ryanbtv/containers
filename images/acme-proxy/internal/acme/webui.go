package acme

import (
	"html/template"
	"net/http"
	"sort"
	"time"
)

// certificateView is one row of the certificate list, shared by the JSON API
// and the HTML page.
type certificateView struct {
	Sans              []string `json:"sans"`
	CommonName        string   `json:"common_name"`
	Serial            string   `json:"serial"`
	IssuedAt          string   `json:"issued_at"`
	NotBefore         string   `json:"not_before"`
	NotAfter          string   `json:"not_after"`
	DaysRemaining     int      `json:"days_remaining"`
	Revoked           bool     `json:"revoked"`
	AccountThumbprint string   `json:"account_thumbprint"`
}

func (s *Server) buildCertificateViews(r *http.Request) ([]certificateView, error) {
	certs, err := s.store.ListCertificates(r.Context())
	if err != nil {
		return nil, err
	}
	now := time.Now()
	views := make([]certificateView, 0, len(certs))
	for _, c := range certs {
		views = append(views, certificateView{
			Sans:              c.Sans,
			CommonName:        c.CommonName,
			Serial:            c.Serial,
			IssuedAt:          c.IssuedAt.UTC().Format(time.RFC3339),
			NotBefore:         c.NotBefore.UTC().Format(time.RFC3339),
			NotAfter:          c.NotAfter.UTC().Format(time.RFC3339),
			DaysRemaining:     int(c.NotAfter.Sub(now) / (24 * time.Hour)),
			Revoked:           c.Revoked,
			AccountThumbprint: c.AccountThumbprint,
		})
	}
	sort.Slice(views, func(i, j int) bool { return views[i].NotAfter < views[j].NotAfter })
	return views, nil
}

func (s *Server) handleAPICertificates(w http.ResponseWriter, r *http.Request) {
	views, err := s.buildCertificateViews(r)
	if err != nil {
		s.logger.Error("certificate list failed", "err", err)
		http.Error(w, "database unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"certificates": views})
}

// pageIndex is a minimal dependency-free listing of issued certificates,
// color-coded by expiry. Internal-only ingress; no auth by design.
const pageIndex = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>acme-proxy</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem;color:#222;background:#fff}
 h1{font-size:1.2rem} .sub{color:#666;margin-top:-0.5rem}
 table{border-collapse:collapse;width:100%} th,td{padding:.4rem .6rem;border-bottom:1px solid #ddd;text-align:left;white-space:nowrap}
 td.sans{white-space:normal;word-break:break-all}
 .ok{color:#0a7a2f} .soon{color:#b45309} .exp{color:#b91c1c;font-weight:600} .rev{color:#666;text-decoration:line-through}
 a{color:#0b5fa5}
</style></head><body>
<h1>acme-proxy</h1>
<p class="sub">ACME front for <code>*.ryanb.tv</code> &mdash; http-01 here, Let&rsquo;s Encrypt DNS-01 upstream.
API: <a href="/api/v1/certificates">/api/v1/certificates</a> &middot; <a href="/metrics">/metrics</a></p>
{{if not .}}<p>No certificates issued yet.</p>{{else}}
<table>
<tr><th>Status</th><th>Names</th><th>Expires</th><th>Days left</th><th>Serial</th></tr>
{{range .}}<tr>
{{if .Revoked}}<td class="rev">revoked</td>
{{else if lt .DaysRemaining 0}}<td class="exp">expired</td>
{{else if lt .DaysRemaining 14}}<td class="exp">expiring</td>
{{else if lt .DaysRemaining 30}}<td class="soon">renew soon</td>
{{else}}<td class="ok">valid</td>{{end}}
<td class="sans">{{range $i, $n := .Sans}}{{if $i}}, {{end}}{{$n}}{{end}}</td>
<td>{{.NotAfter}}</td><td>{{.DaysRemaining}}</td><td>{{.Serial}}</td>
</tr>{{end}}
</table>{{end}}
</body></html>`

var pageIndexTpl = template.Must(template.New("index").Parse(pageIndex))

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	views, err := s.buildCertificateViews(r)
	if err != nil {
		s.logger.Error("certificate list failed", "err", err)
		http.Error(w, "database unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := pageIndexTpl.Execute(w, views); err != nil {
		s.logger.Error("page render failed", "err", err)
	}
}
