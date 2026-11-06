package store_test

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

func TestCommentCreateListAndDelete(t *testing.T) {
	database, people := accessRequestFixture(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 13, 7, 10, 0, 0, time.UTC)
	comments := make([]domain.AppComment, 4)
	if err := database.Do(ctx, true, func(tx *store.Tx) error {
		for i, input := range []struct {
			appID  string
			author domain.Person
			body   string
		}{
			{"app", people[1], "見積書について質問があります"},
			{"app", people[2], "うちの部署でも使いたいです"},
			{"app", people[1], "PDF で出せました"},
			{"other-app", people[1], "申請の手順が分かりました"},
		} {
			comment, err := tx.CreateComment(input.appID, input.author.ID, input.body)
			if err != nil {
				return err
			}
			if comment.ID == "" || comment.AppID != input.appID || comment.Author != input.author || comment.Body != input.body || comment.CreatedAt.IsZero() {
				t.Fatalf("created comment=%+v", comment)
			}
			// Fix distinct timestamps without sleeps or reliance on transaction now().
			comment.CreatedAt = at.Add(time.Duration(i) * time.Minute)
			if err := tx.Exec(`UPDATE app_comments SET created_at=$2 WHERE id=$1`, comment.ID, comment.CreatedAt); err != nil {
				return err
			}
			comments[i] = comment
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	people[1].DisplayName = "Updated Author"
	for i := range comments {
		if comments[i].Author.ID == people[1].ID {
			comments[i].Author = people[1]
		}
	}
	checkIDs := func(got []domain.AppComment, err error, want ...string) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]string, len(got))
		for i, comment := range got {
			ids[i] = comment.ID
			if comment.Author.Email == "" || comment.Author.Subject == "" {
				t.Fatalf("author not hydrated: %+v", comment)
			}
		}
		if got == nil || !slices.Equal(ids, want) {
			t.Fatalf("comment IDs=%v, want %v (nil=%v)", ids, want, got == nil)
		}
	}
	if err := database.Do(ctx, false, func(tx *store.Tx) error {
		got, err := tx.Comment(comments[0].ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(got.Author, comments[0].Author) || got.ID != comments[0].ID || got.AppID != comments[0].AppID || got.Body != comments[0].Body || !got.CreatedAt.Equal(comments[0].CreatedAt) {
			t.Fatalf("stored comment=%+v, want %+v", got, comments[0])
		}
		all, err := tx.Comments("app", 100)
		checkIDs(all, err, comments[2].ID, comments[1].ID, comments[0].ID)
		limited, err := tx.Comments("app", 2)
		checkIDs(limited, err, comments[2].ID, comments[1].ID)
		empty, err := tx.Comments("app", 0)
		checkIDs(empty, err)
		empty, err = tx.Comments("missing", 100)
		checkIDs(empty, err)
		other, err := tx.Comments("other-app", 100)
		checkIDs(other, err, comments[3].ID)
		count, err := tx.CountOpenComments(people[1].ID)
		if err != nil || count != 3 {
			t.Fatalf("open comment count=%d err=%v", count, err)
		}
		count, err = tx.CountOpenComments(people[2].ID)
		if err != nil || count != 1 {
			t.Fatalf("other author's count=%d err=%v", count, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.Do(ctx, true, func(tx *store.Tx) error {
		return tx.DeleteComment(comments[2].ID, people[0].ID)
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.Do(ctx, false, func(tx *store.Tx) error {
		remaining, err := tx.Comments("app", 100)
		checkIDs(remaining, err, comments[1].ID, comments[0].ID)
		if _, err := tx.Comment(comments[2].ID); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("deleted comment error=%v, want sql.ErrNoRows", err)
		}
		if _, err := tx.Comment("missing"); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("missing comment error=%v, want sql.ErrNoRows", err)
		}
		count, err := tx.CountOpenComments(people[1].ID)
		if err != nil || count != 2 {
			t.Fatalf("deleted comment counted: count=%d err=%v", count, err)
		}
		count, err = tx.CountOpenComments("missing")
		if err != nil || count != 0 {
			t.Fatalf("missing author's count=%d err=%v", count, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.Do(ctx, true, func(tx *store.Tx) error {
		for _, id := range []string{comments[2].ID, "missing"} {
			if err := tx.DeleteComment(id, people[0].ID); !errors.Is(err, sql.ErrNoRows) {
				t.Fatalf("delete %q error=%v, want sql.ErrNoRows", id, err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
