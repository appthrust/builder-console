// Package directoryview maps the Directory contract into console domain values.
// HTTP, bindings, ETags and error classification belong to the shared link client.
package directoryview

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

const ttl = 60 * time.Second

type cached[T any] struct {
	value   T
	expires time.Time
}

type cacheKey struct{ bearer, id string }

type View struct {
	client    *link.Client
	now       func() time.Time
	mu        sync.Mutex
	people    map[cacheKey]cached[domain.Person]
	subjects  map[cacheKey]cached[domain.Person]
	effective map[cacheKey]cached[[]string]
	groups    map[string]cached[[]domain.Group]
}

func New(client *link.Client) *View {
	return &View{client: client, now: time.Now, people: map[cacheKey]cached[domain.Person]{}, subjects: map[cacheKey]cached[domain.Person]{}, effective: map[cacheKey]cached[[]string]{}, groups: map[string]cached[[]domain.Group]{}}
}

func person(p directory.Person) domain.Person {
	result := domain.Person{ID: p.ID, Email: p.Email, DisplayName: p.DisplayName, AvatarUpdatedAt: p.AvatarVersion}
	if p.Subject != nil {
		result.Subject = *p.Subject
	}
	return result
}

type Me struct {
	Person            domain.Person
	EffectiveGroupIDs []string
}

func (v *View) Me(ctx context.Context, bearer string) (Me, error) {
	var response directory.MeResponse
	if err := v.client.Do(ctx, bearer, directory.Me, link.Params{}, nil, &response); err != nil {
		return Me{}, err
	}
	result := Me{Person: person(response.Person), EffectiveGroupIDs: response.EffectiveGroupIDs}
	v.mu.Lock()
	v.people[cacheKey{bearer, result.Person.ID}] = cached[domain.Person]{result.Person, v.now().Add(ttl)}
	delete(v.subjects, cacheKey{bearer, result.Person.Subject})
	v.mu.Unlock()
	return result, nil
}

// Session memoizes both found and missing IDs for one request, including writes.
type Session struct {
	view   *View
	ctx    context.Context
	bearer string
	people map[string]domain.Person
}

func (v *View) Session(ctx context.Context, bearer string) *Session {
	return &Session{view: v, ctx: ctx, bearer: bearer, people: map[string]domain.Person{}}
}

func (s *Session) People(ids []string) (map[string]domain.Person, error) {
	missing := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		if _, ok := s.people[id]; !ok && !seen[id] {
			missing = append(missing, id)
			seen[id] = true
		}
	}
	found, err := s.view.People(s.ctx, s.bearer, missing)
	if err != nil {
		return nil, err
	}
	for id, p := range found {
		s.people[id] = p
	}
	return s.people, nil
}

func (v *View) People(ctx context.Context, bearer string, ids []string) (map[string]domain.Person, error) {
	result := make(map[string]domain.Person, len(ids))
	var missing []string
	v.mu.Lock()
	for _, id := range ids {
		if _, ok := result[id]; ok {
			continue
		}
		if entry, ok := v.people[cacheKey{bearer, id}]; ok && v.now().Before(entry.expires) {
			result[id] = entry.value
		} else {
			result[id] = domain.Person{ID: id, Unknown: true}
			missing = append(missing, id)
		}
	}
	v.mu.Unlock()
	// Keep the console's bounded aggregation: each batch is one link operation.
	for start := 0; start < len(missing); start += 100 {
		batch := missing[start:min(start+100, len(missing))]
		var response directory.PersonList
		err := v.client.Do(ctx, bearer, directory.ListPeople, link.Params{Query: url.Values{"ids": {strings.Join(batch, ",")}, "limit": {"100"}}}, nil, &response)
		if err != nil {
			return nil, err
		}
		for _, p := range response.Items {
			if _, ok := result[p.ID]; ok {
				result[p.ID] = person(p)
			}
		}
		v.mu.Lock()
		for _, id := range batch {
			v.people[cacheKey{bearer, id}] = cached[domain.Person]{result[id], v.now().Add(ttl)}
		}
		v.mu.Unlock()
	}
	return result, nil
}

func (v *View) PersonBySubject(ctx context.Context, bearer, subject string) (domain.Person, error) {
	key := cacheKey{bearer, subject}
	v.mu.Lock()
	entry, ok := v.subjects[key]
	v.mu.Unlock()
	if ok && v.now().Before(entry.expires) {
		return entry.value, nil
	}
	var response directory.PersonList
	if err := v.client.Do(ctx, bearer, directory.ListPeople, link.Params{Query: url.Values{"subject": {subject}}}, nil, &response); err != nil {
		return domain.Person{}, err
	}
	var result domain.Person
	if len(response.Items) > 0 {
		result = person(response.Items[0])
	}
	v.mu.Lock()
	v.subjects[key] = cached[domain.Person]{result, v.now().Add(ttl)}
	v.mu.Unlock()
	return result, nil
}

func (v *View) EffectiveGroups(ctx context.Context, bearer, personID string) ([]string, error) {
	key := cacheKey{bearer, personID}
	v.mu.Lock()
	entry, ok := v.effective[key]
	v.mu.Unlock()
	if ok && v.now().Before(entry.expires) {
		return entry.value, nil
	}
	var response directory.EffectiveGroupsResponse
	if err := v.client.Do(ctx, bearer, directory.EffectiveGroups, link.Params{Path: map[string]string{"id": personID}}, nil, &response); err != nil {
		return nil, err
	}
	if response.GroupIDs == nil {
		response.GroupIDs = []string{}
	}
	v.mu.Lock()
	v.effective[key] = cached[[]string]{response.GroupIDs, v.now().Add(ttl)}
	v.mu.Unlock()
	return response.GroupIDs, nil
}

func (v *View) Groups(ctx context.Context, bearer string) ([]domain.Group, error) {
	v.mu.Lock()
	entry := v.groups[bearer]
	v.mu.Unlock()
	if v.now().Before(entry.expires) {
		return entry.value, nil
	}
	var response directory.GroupList
	if err := v.client.Do(ctx, bearer, directory.ListGroups, link.Params{}, nil, &response); err != nil {
		return nil, err
	}
	groups := make([]domain.Group, len(response.Items))
	for i, g := range response.Items {
		groups[i] = domain.Group{ID: g.ID, ParentID: g.ParentID, Name: g.Name, Slug: g.Slug, Path: g.Path, Description: g.Description, About: g.About, AboutUpdatedAt: g.AboutUpdatedAt, MemberCount: g.MemberCount, CreatedAt: g.CreatedAt, UpdatedAt: g.UpdatedAt}
		if g.AboutUpdatedBy != nil {
			by := person(*g.AboutUpdatedBy)
			groups[i].AboutUpdatedBy = &by
		}
	}
	v.mu.Lock()
	v.groups[bearer] = cached[[]domain.Group]{groups, v.now().Add(ttl)}
	v.mu.Unlock()
	return groups, nil
}

func (v *View) Profile(ctx context.Context, bearer, id string) (domain.PersonProfile, error) {
	var response directory.PersonProfile
	if err := v.client.Do(ctx, bearer, directory.GetPerson, link.Params{Path: map[string]string{"id": id}}, nil, &response); err != nil {
		return domain.PersonProfile{}, err
	}
	result := domain.PersonProfile{Person: person(response.Person), Memberships: make([]domain.PersonMembership, len(response.Memberships))}
	for i, m := range response.Memberships {
		result.Memberships[i] = domain.PersonMembership{Group: domain.AppGroup{ID: m.Group.ID, Name: m.Group.Name, Path: m.Group.Path}, Role: m.Role}
	}
	return result, nil
}

func (v *View) Import(ctx context.Context, bearer string, payload directory.ImportRequest) (directory.ImportResult, error) {
	var result directory.ImportResult
	err := v.client.Do(ctx, bearer, directory.Import, link.Params{}, payload, &result)
	return result, err
}
