package api

import (
	"context"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/link"
)

func (a *API) directoryProxy() http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.Host = r.Out.URL.Host
			r.Out.URL.Path = "/api/directory/v1/" + strings.TrimPrefix(r.In.URL.Path, "/api/console/directory/")
			r.Out.URL.RawPath = ""
			r.Out.Header.Del("Cookie")
			r.Out.Header.Del("Forwarded")
			for key := range r.Out.Header {
				if strings.HasPrefix(strings.ToLower(key), "x-forwarded-") {
					r.Out.Header.Del(key)
				}
			}
		},
		ModifyResponse: func(r *http.Response) error {
			if r.StatusCode >= 500 {
				return link.ErrUnavailable
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			httpx.WriteError(w, directoryError(link.ErrUnavailable), "console")
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			httpx.WriteError(w, httpx.Fail(401, "unauthenticated", "A valid bearer token is required"), "console")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if a.links == nil {
			httpx.WriteError(w, directoryError(link.ErrUnavailable), "console")
			return
		}
		binding, err := a.links.Resolver().Resolve(ctx, r.Header.Get("Authorization"), "directory")
		if err == nil && binding.State != link.StateReady {
			err = link.ErrUnavailable
		}
		if err != nil {
			httpx.WriteError(w, directoryError(err), "console")
			return
		}
		upstream, err := url.Parse(binding.InternalURL)
		if err != nil {
			httpx.WriteError(w, directoryError(link.ErrUnavailable), "console")
			return
		}
		r = r.Clone(ctx)
		r.URL.Scheme, r.URL.Host = upstream.Scheme, upstream.Host
		proxy.ServeHTTP(w, r)
	})
}
