package domain

import (
	"testing"
	"time"
)

func TestDeriveInbox(t *testing.T) {
	at := time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)
	actor := Actor{PersonID: "owner"}
	apps := []App{
		{ID: "first", Slug: "first", Group: AppGroup{Path: "sales"}, Owners: []Person{{ID: "owner"}}},
		{ID: "second", Owners: []Person{{ID: "owner"}}},
		{ID: "zero", Owners: []Person{{ID: "owner"}}},
		{ID: "not-maintained"},
	}
	events := []InboxActivity{
		{AppID: "first", Kind: "accessRequest", Status: RequestPending, At: at},
		{AppID: "first", Kind: "accessRequest", Status: RequestPending, At: at.Add(time.Minute)},
		{AppID: "first", Kind: "accessRequest", Status: RequestApproved, At: at.Add(time.Hour)},
		{AppID: "second", Kind: "accessRequest", Status: RequestPending, At: at.Add(2 * time.Minute)},
		{AppID: "first", Kind: "feedback", AuthorID: "other", At: at.Add(time.Hour), LastSeenAt: at},
		{AppID: "first", Kind: "feedback", AuthorID: "owner", At: at.Add(2 * time.Hour)},
		{AppID: "first", Kind: "feedback", AuthorID: "other", At: at, LastSeenAt: at},
		{AppID: "first", Kind: "feedback", AuthorID: "other", At: at.Add(-time.Hour), LastSeenAt: at},
		{AppID: "second", Kind: "feedback", AuthorID: "other", At: at.Add(3 * time.Hour)},
		{AppID: "not-maintained", Kind: "feedback", AuthorID: "other", At: at},
	}
	items := DeriveInbox(actor, apps, events)
	if len(items) != 4 {
		t.Fatalf("items = %+v", items)
	}
	for i, want := range []struct{ kind, app string; count int }{{"accessRequest", "second", 1}, {"accessRequest", "first", 2}, {"feedback", "second", 1}, {"feedback", "first", 1}} {
		got := items[i]
		if got.Kind != want.kind || got.App.ID != want.app || got.Count != want.count {
			t.Fatalf("item %d = %+v, want %+v", i, got, want)
		}
	}
	if items[1].App.Path != "sales/first" || !items[1].Since.Equal(at.Add(time.Minute)) || !items[3].Since.Equal(at.Add(time.Hour)) {
		t.Fatalf("incorrect app path or latest activity: %+v", items)
	}
	if empty := DeriveInbox(actor, apps, nil); empty == nil || len(empty) != 0 {
		t.Fatalf("empty inbox must be [], got %#v", empty)
	}
}
