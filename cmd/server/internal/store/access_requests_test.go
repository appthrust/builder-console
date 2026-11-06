package store_test

import (
	"context"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

func accessRequestFixture(t *testing.T) (*fixtureStore, []domain.Person) {
	t.Helper()
	database, _ := testutil.Database(t, store.Open)
	people := make([]domain.Person, 4)
	fixture := &fixtureStore{Store: database, people: people}
	if err := database.Do(context.Background(), true, func(tx *store.Tx) error {
		for i, name := range []string{"owner", "requester", "other", "third"} {
			people[i] = domain.Person{ID: name, Subject: name, Email: name + "@example.test", DisplayName: name}
		}
		for _, id := range []string{"app", "other-app"} {
			if err := tx.CreateApp(domain.App{
				ID: id, Slug: id, DisplayName: id, Group: domain.AppGroup{ID: "group"}, CreatedBy: people[0],
				Tags: []string{}, Share: domain.SharePolicy{Scope: "private", GroupIDs: []string{}, ExtraPersonIDs: []string{}},
			}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return fixture, people
}

type fixtureStore struct {
	*store.Store
	people []domain.Person
}

func (s *fixtureStore) Do(ctx context.Context, write bool, fn func(*store.Tx) error) error {
	return s.Store.Do(ctx, write, func(tx *store.Tx) error {
		tx.DirectoryGroups = []domain.Group{{ID: "group", Path: "group", Name: "Group"}}
		tx.HydratePeople = func(ids []string) (map[string]domain.Person, error) {
			result := map[string]domain.Person{}
			for _, id := range ids {
				result[id] = domain.Person{ID: id, Unknown: true}
				for _, p := range s.people {
					if p.ID == id {
						result[id] = p
						break
					}
				}
			}
			return result, nil
		}
		return fn(tx)
	})
}

func TestAccessRequestQueriesAndDecisions(t *testing.T) {
	database, people := accessRequestFixture(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 11, 7, 10, 0, 123456000, time.UTC)
	requests := []domain.AppAccessRequest{
		{ID: "declined", AppID: "app", Requester: people[1], Status: domain.RequestPending, RequestedAt: at},
		{ID: "approved", AppID: "app", Requester: people[3], Status: domain.RequestPending, RequestedAt: at.Add(time.Minute)},
		{ID: "pending-first", AppID: "app", Requester: people[1], Message: "棚卸", Status: domain.RequestPending, RequestedAt: at.Add(2 * time.Minute)},
		{ID: "pending-second", AppID: "app", Requester: people[2], Status: domain.RequestPending, RequestedAt: at.Add(3 * time.Minute)},
		{ID: "other-app-pending", AppID: "other-app", Requester: people[1], Status: domain.RequestPending, RequestedAt: at.Add(4 * time.Minute)},
	}
	if err := database.Do(ctx, true, func(tx *store.Tx) error {
		for _, r := range requests {
			if err := tx.CreateAccessRequest(r); err != nil {
				return err
			}
			switch r.ID {
			case "declined":
				if err := tx.DecideAccessRequest(r.ID, domain.RequestDeclined, people[0].ID, at.Add(8*time.Minute)); err != nil {
					return err
				}
			case "approved":
				if err := tx.DecideAccessRequest(r.ID, domain.RequestApproved, people[0].ID, at.Add(7*time.Minute)); err != nil {
					return err
				}
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	people[1].DisplayName = "Updated Requester"
	if err := database.Do(ctx, false, func(tx *store.Tx) error {
		latest, found, err := tx.LatestAccessRequest("app", people[1].ID)
		if err != nil {
			return err
		}
		if !found || latest.ID != "pending-first" || latest.Requester != people[1] || latest.Message != "棚卸" || !latest.RequestedAt.Equal(requests[2].RequestedAt) || latest.DecidedAt != nil || latest.DecidedBy != nil {
			t.Fatalf("latest=%+v found=%v", latest, found)
		}
		if _, found, err := tx.LatestAccessRequest("missing", people[1].ID); err != nil || found {
			t.Fatalf("missing latest: found=%v err=%v", found, err)
		}
		var missing *httpx.Error
		if _, err := tx.AccessRequest("missing"); !errors.As(err, &missing) || missing.Status != 404 || missing.Code != "not_found" {
			t.Fatalf("missing request error=%v", err)
		}
		decided, err := tx.AccessRequest("declined")
		if err != nil {
			return err
		}
		if decided.Status != domain.RequestDeclined || decided.Requester != people[1] || decided.DecidedBy == nil || decided.DecidedBy.ID != people[0].ID || decided.DecidedAt == nil || !decided.DecidedAt.Equal(at.Add(8*time.Minute)) {
			t.Fatalf("decided=%+v", decided)
		}
		checkIDs := func(got []domain.AppAccessRequest, err error, want ...string) {
			t.Helper()
			if err != nil {
				t.Fatal(err)
			}
			ids := make([]string, len(got))
			for i, r := range got {
				ids[i] = r.ID
				if r.Requester.Email == "" || r.Requester.Subject == "" {
					t.Fatalf("requester not hydrated: %+v", r)
				}
			}
			if got == nil || !slices.Equal(ids, want) {
				t.Fatalf("request IDs=%v, want %v (nil=%v)", ids, want, got == nil)
			}
		}
		pending, err := tx.PendingAccessRequests([]string{"app"})
		checkIDs(pending, err, "pending-first", "pending-second")
		pending, err = tx.PendingAccessRequests([]string{"app", "other-app"})
		checkIDs(pending, err, "pending-first", "pending-second", "other-app-pending")
		pending, err = tx.PendingAccessRequests(nil)
		checkIDs(pending, err)
		pending, err = tx.PendingAccessRequests([]string{"missing"})
		checkIDs(pending, err)
		all, err := tx.AccessRequests("app", 20)
		checkIDs(all, err, "pending-first", "pending-second", "declined", "approved")
		all, err = tx.AccessRequests("app", 3)
		checkIDs(all, err, "pending-first", "pending-second", "declined")
		all, err = tx.AccessRequests("app", 0)
		checkIDs(all, err)
		count, err := tx.CountPendingAccessRequests(people[1].ID)
		if err != nil || count != 2 {
			t.Fatalf("pending count=%d err=%v", count, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"declined", "approved", "missing"} {
		err := database.Do(ctx, true, func(tx *store.Tx) error {
			return tx.DecideAccessRequest(id, domain.RequestDeclined, people[0].ID, at.Add(9*time.Minute))
		})
		var conflict *httpx.Error
		if !errors.As(err, &conflict) || conflict.Status != 409 || conflict.Code != "conflict" || conflict.Message != "The request is no longer pending" {
			t.Fatalf("deciding %s: %v", id, err)
		}
	}
}

func TestAccessRequestConstraints(t *testing.T) {
	database, people := accessRequestFixture(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 11, 7, 10, 0, 0, time.UTC)
	base := domain.AppAccessRequest{ID: "request", AppID: "app", Requester: people[1], Status: domain.RequestPending, Message: strings.Repeat("字", domain.MaxAccessRequestMessage), RequestedAt: at}
	if err := database.Do(ctx, true, func(tx *store.Tx) error { return tx.CreateAccessRequest(base) }); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*domain.AppAccessRequest)
		status int
	}{
		{"duplicate pending", func(r *domain.AppAccessRequest) {}, 409},
		{"long message", func(r *domain.AppAccessRequest) { r.Message += "字" }, 400},
		{"unknown status", func(r *domain.AppAccessRequest) { r.Status = "unknown" }, 400},
		{"decided without timestamp", func(r *domain.AppAccessRequest) { r.Status = domain.RequestApproved }, 400},
		{"missing app", func(r *domain.AppAccessRequest) { r.AppID = "missing" }, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := base
			r.ID = tc.name
			tc.change(&r)
			err := database.Do(ctx, true, func(tx *store.Tx) error { return tx.CreateAccessRequest(r) })
			var got *httpx.Error
			if !errors.As(err, &got) || got.Status != tc.status {
				t.Fatalf("constraint %s error=%v, want %d", tc.name, err, tc.status)
			}
		})
	}
	for _, tc := range []struct {
		name    string
		status  domain.RequestStatus
		decider string
	}{
		{"pending with timestamp", domain.RequestPending, people[0].ID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := database.Do(ctx, true, func(tx *store.Tx) error { return tx.DecideAccessRequest(base.ID, tc.status, tc.decider, at) })
			var got *httpx.Error
			if !errors.As(err, &got) || got.Status != 400 {
				t.Fatalf("decision constraint error=%v", err)
			}
		})
	}
}

func TestAccessRequestApprovalTransaction(t *testing.T) {
	database, people := accessRequestFixture(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 11, 7, 10, 0, 0, time.UTC)
	r := domain.AppAccessRequest{ID: "request", AppID: "app", Requester: people[1], Status: domain.RequestPending, RequestedAt: at}
	if err := database.Do(ctx, true, func(tx *store.Tx) error { return tx.CreateAccessRequest(r) }); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("rollback approval")
	for _, abort := range []bool{true, false} {
		err := database.Do(ctx, true, func(tx *store.Tx) error {
			app, err := tx.App(r.AppID)
			if err != nil {
				return err
			}
			requester := domain.NewActor(r.Requester.ID, domain.Roles{}, nil, nil)
			if err := tx.SaveApp(app, domain.ApproveAccess(app, r.Requester.ID, requester.Visible(app))); err != nil {
				return err
			}
			if err := tx.DecideAccessRequest(r.ID, domain.RequestApproved, people[0].ID, at.Add(time.Minute)); err != nil {
				return err
			}
			if abort {
				return failure
			}
			return nil
		})
		if abort && !errors.Is(err, failure) || !abort && err != nil {
			t.Fatalf("approval abort=%v err=%v", abort, err)
		}
		if err := database.Do(ctx, false, func(tx *store.Tx) error {
			app, err := tx.App(r.AppID)
			if err != nil {
				return err
			}
			got, err := tx.AccessRequest(r.ID)
			if err != nil {
				return err
			}
			if abort {
				if len(app.Share.ExtraPersonIDs) != 0 || got.Status != domain.RequestPending || got.DecidedBy != nil || got.DecidedAt != nil {
					t.Fatalf("partial approval persisted: app=%+v request=%+v", app, got)
				}
			} else if !slices.Equal(app.Share.ExtraPersonIDs, []string{r.Requester.ID}) || got.Status != domain.RequestApproved || !reflect.DeepEqual(app.Owners, []domain.Person{people[0]}) {
				t.Fatalf("approval did not persist together: app=%+v request=%+v", app, got)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAccessRequestCascadeDeletion(t *testing.T) {
	for _, target := range []string{"app", "requester"} {
		t.Run(target, func(t *testing.T) {
			database, people := accessRequestFixture(t)
			ctx := context.Background()
			if err := database.Do(ctx, true, func(tx *store.Tx) error {
				if err := tx.CreateAccessRequest(domain.AppAccessRequest{ID: "request", AppID: "app", Requester: people[1], Status: domain.RequestPending, RequestedAt: time.Now().UTC()}); err != nil {
					return err
				}
				if target == "app" {
					return tx.DeleteApp("app")
				}
				database.people = []domain.Person{people[0], people[2], people[3]}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if err := database.Do(ctx, false, func(tx *store.Tx) error {
				request, found, err := tx.LatestAccessRequest("app", people[1].ID)
				if err != nil || found != (target == "requester") {
					t.Fatalf("latest found=%v err=%v", found, err)
				}
				if found && !request.Requester.Unknown {
					t.Fatal("deleted Directory person was not unknown")
				}
				count, err := tx.CountPendingAccessRequests(people[1].ID)
				want := 0
				if target == "requester" {
					want = 1
				}
				if err != nil || count != want {
					t.Fatalf("pending count=%d want=%d err=%v", count, want, err)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
