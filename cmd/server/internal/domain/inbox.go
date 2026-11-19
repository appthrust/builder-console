package domain

import (
	"cmp"
	"slices"
	"time"
)

type InboxApp struct {
	ID          string `json:"id"`
	Path        string `json:"path"`
	DisplayName string `json:"displayName"`
	Icon        string `json:"icon"`
}

type InboxItem struct {
	Kind  string    `json:"kind"`
	App   InboxApp  `json:"app"`
	Count int       `json:"count"`
	Since time.Time `json:"since"`
}

// InboxActivity carries only the evidence needed to count an item, never its body.
type InboxActivity struct {
	AppID, Kind, AuthorID string
	Status               RequestStatus
	At, LastSeenAt       time.Time
}

func DeriveInbox(actor Actor, apps []App, activity []InboxActivity) []InboxItem {
	maintained := make(map[string]InboxApp, len(apps))
	for _, app := range apps {
		if Capabilities(actor, app).Maintain {
			maintained[app.ID] = InboxApp{ID: app.ID, Path: app.Path(), DisplayName: app.DisplayName, Icon: app.Icon}
		}
	}
	type key struct{ app, kind string }
	indices := make(map[key]int)
	items := []InboxItem{}
	for _, event := range activity {
		app, ok := maintained[event.AppID]
		if !ok {
			continue
		}
		switch event.Kind {
		case "accessRequest":
			if event.Status != RequestPending {
				continue
			}
		case "feedback":
			if event.AuthorID == actor.PersonID || !event.At.After(event.LastSeenAt) {
				continue
			}
		default:
			continue
		}
		k := key{event.AppID, event.Kind}
		i, exists := indices[k]
		if !exists {
			i = len(items)
			indices[k] = i
			items = append(items, InboxItem{Kind: event.Kind, App: app, Since: event.At})
		}
		items[i].Count++
		if event.At.After(items[i].Since) {
			items[i].Since = event.At
		}
	}
	slices.SortFunc(items, func(a, b InboxItem) int {
		if order := cmp.Compare(a.Kind, b.Kind); order != 0 {
			return order
		}
		if order := b.Since.Compare(a.Since); order != 0 {
			return order
		}
		return cmp.Compare(a.App.ID, b.App.ID)
	})
	return items
}
