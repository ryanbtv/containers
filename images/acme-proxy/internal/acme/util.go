package acme

import (
	"encoding/json"
	"io"
	"regexp"
	"strconv"
)

func jsonEncoder(w io.Writer) *json.Encoder {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return enc
}

func parseInt64(s string) (int64, error) { return strconv.ParseInt(s, 10, 64) }

func itoa(v int64) string { return strconv.FormatInt(v, 10) }

// dnsNameRe matches a lowercase, non-wildcard DNS name with legal labels.
var dnsNameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)
