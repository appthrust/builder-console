package domain

import "testing"

func TestCapabilities(t *testing.T) {
	all := Permissions{Use: true, Comment: true, Propose: true, Maintain: true, Data: true}
	use := Permissions{Use: true, Comment: true}
	propose := Permissions{Use: true, Comment: true, Propose: true}
	for _, tc := range []struct {
		name, person, role, contribution, share string
		create, admin, invited                  bool
		want                                    Permissions
	}{
		{"owner off private", "owner", "", "off", "private", false, false, false, all},
		{"inherited manager off private", "manager", "manager", "off", "private", false, false, false, all},
		{"console admin off private", "admin", "", "off", "private", false, true, false, all},
		{"member group", "member", "member", "group", "group", true, false, false, propose},
		{"member off", "member", "member", "off", "group", true, false, false, use},
		{"member company", "member", "member", "company", "group", true, false, false, propose},
		{"member cannot build", "member", "member", "company", "group", false, false, false, use},
		{"nonmember company", "other", "", "company", "company", true, false, false, propose},
		{"nonmember group", "other", "", "group", "company", true, false, false, use},
		{"cannot use", "other", "", "company", "private", true, false, false, Permissions{}},
		{"invited outside group", "other", "", "group", "private", true, false, true, use},
		{"invited company", "other", "", "company", "private", true, false, true, propose},
		{"unknown scope", "member", "member", "future", "group", true, false, false, use},
	} {
		t.Run(tc.name, func(t *testing.T) {
			actor := Actor{PersonID: tc.person, Roles: Roles{CanCreateApps: tc.create, IsConsoleAdmin: tc.admin}, GroupRoles: map[string]string{"child": tc.role}}
			if tc.role != "" {
				actor.ShareGroupIDs = []string{"child"}
			}
			app := App{Group: AppGroup{ID: "child"}, Owners: []Person{{ID: "owner"}}, Share: SharePolicy{Scope: tc.share, GroupIDs: []string{"child"}}, Contribution: ContributionPolicy{Scope: tc.contribution}}
			if tc.invited {
				app.Share.ExtraPersonIDs = []string{tc.person}
			}
			if got := Capabilities(actor, app); got != tc.want {
				t.Fatalf("Capabilities() = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestCapabilitiesEffectiveMembership(t *testing.T) {
	actor := NewActor("person", Roles{CanCreateApps: true}, []string{"parent", "child"}, []Group{{ID: "parent", Path: "parent"}, {ID: "child", Path: "parent/child"}})
	app := App{Group: AppGroup{ID: "child"}, Share: SharePolicy{Scope: "group", GroupIDs: []string{"child"}}, Contribution: ContributionPolicy{Scope: "group"}}
	if !Capabilities(actor, app).Propose {
		t.Fatal("effective inherited membership must permit proposals")
	}
}
