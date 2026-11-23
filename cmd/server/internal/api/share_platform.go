package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/platformenv"
)

type shareSubject struct {
	Kind    string `json:"kind"`
	Name    string `json:"name,omitempty"`
	Issuer  string `json:"issuer,omitempty"`
	Subject string `json:"subject,omitempty"`
}
type organizationPersonRef struct {
	SourceUID string `json:"sourceUID"`
	PersonID  string `json:"personID"`
}
type organizationGroupSourceRef struct {
	SourceUID string `json:"sourceUID"`
}
type shareBindingInput struct {
	Role                   string                  `json:"role"`
	Subjects               []shareSubject          `json:"subjects"`
	OrganizationPersonRefs []organizationPersonRef `json:"organizationPersonRefs,omitempty"`
}
type shareBinding struct {
	Name                       string                      `json:"name"`
	Role                       string                      `json:"role"`
	Subjects                   []shareSubject              `json:"subjects"`
	OrganizationPersonRefs     []organizationPersonRef     `json:"organizationPersonRefs,omitempty"`
	OrganizationGroupSourceRef *organizationGroupSourceRef `json:"organizationGroupSourceRef,omitempty"`
	ManagedFor                 string                      `json:"managedFor,omitempty"`
	ETag                       string                      `json:"etag,omitempty"`
}
type shareBindings struct {
	Bindings           []shareBinding `json:"bindings"`
	CanManageBindings  bool           `json:"canManageBindings"`
	OrganizationGroups struct {
		Declared bool     `json:"declared"`
		Accepted bool     `json:"accepted"`
		Roles    []string `json:"roles"`
	} `json:"organizationGroups"`
	OrganizationSource *struct {
		SourceUID           string `json:"sourceUID"`
		Ready               bool   `json:"ready"`
		InitialSyncComplete bool   `json:"initialSyncComplete"`
		AppliedVersion      string `json:"appliedVersion"`
		ConsecutiveFailures int    `json:"consecutiveFailures"`
	} `json:"organizationSource,omitempty"`
}
type shareGroup struct {
	ExternalID       string `json:"externalId"`
	BindingGroupName string `json:"bindingGroupName"`
	SourceUID        string `json:"sourceUID"`
}
type cutoverResource struct {
	ID                      string `json:"id"`
	ApplicationUID          string `json:"applicationUID"`
	Direction               string `json:"direction"`
	Phase                   string `json:"phase"`
	Reason                  string `json:"reason"`
	PreviousDigest          string `json:"previousDigest"`
	CookieIsolationVerified bool   `json:"cookieIsolationVerified"`
}
type cutoverResult struct {
	Resource cutoverResource `json:"resource"`
}

type sharePlatform struct {
	origin, prefix string
	http           *http.Client
}

// ConfigureSharing uses the same trust roots as the Console's other Platform
// clients. Every operation forwards the current human's bearer, never a service credential.
func (a *API) ConfigureSharing(origin string, transport http.RoundTripper) error {
	if _, err := platformenv.Validate(origin, a.platform.ProjectID); err != nil {
		return err
	}
	a.sharing = &sharePlatform{origin: strings.TrimRight(origin, "/"), prefix: "/api/v1/projects/" + url.PathEscape(a.platform.ProjectID), http: &http.Client{
		Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
	return nil
}

func (p *sharePlatform) appPath(app string) string { return "/applications/" + url.PathEscape(app) }

func (p *sharePlatform) call(ctx context.Context, bearer, method, path string, body any, headers http.Header, out any) error {
	if p == nil {
		return upstreamError()
	}
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(data)
	}
	r, err := http.NewRequestWithContext(ctx, method, p.origin+p.prefix+path, payload)
	if err != nil {
		return err
	}
	r.Header = headers.Clone()
	if r.Header == nil {
		r.Header = make(http.Header)
	}
	r.Header.Set("Authorization", bearer)
	r.Header.Set("Accept", "application/json")
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	response, err := p.http.Do(r)
	if err != nil {
		return upstreamError()
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == 404 {
			return httpx.NotFound()
		}
		if response.StatusCode == 403 {
			return httpx.Forbidden()
		}
		if response.StatusCode == 409 || response.StatusCode == 412 {
			return httpx.Fail(response.StatusCode, "share_conflict", "Sharing changed; reload before saving")
		}
		if response.StatusCode == 422 {
			return httpx.Fail(422, "share_unavailable", "A sharing recipient is unavailable or exceeds the limit")
		}
		return upstreamError()
	}
	if out == nil || response.StatusCode == 204 {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(out); err != nil {
		return upstreamError()
	}
	return nil
}

func (p *sharePlatform) bindings(ctx context.Context, bearer, app string) (shareBindings, error) {
	var out shareBindings
	if p == nil {
		return out, upstreamError()
	}
	err := p.call(ctx, bearer, "GET", p.appPath(app)+"/role-bindings", nil, nil, &out)
	if err == nil && (out.Bindings == nil || !out.CanManageBindings) {
		err = httpx.Forbidden()
	}
	return out, err
}

func (p *sharePlatform) cutover(ctx context.Context, bearer, app string) (*cutoverResource, error) {
	if p == nil {
		return nil, upstreamError()
	}
	var out cutoverResult
	err := p.call(ctx, bearer, "GET", p.appPath(app)+"/access-cutover", nil, nil, &out)
	var failure *httpx.Error
	if errors.As(err, &failure) && failure.Status == 404 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if out.Resource.Phase == "" {
		return nil, upstreamError()
	}
	return &out.Resource, nil
}
