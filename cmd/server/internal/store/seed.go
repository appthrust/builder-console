package store

import (
	"context"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
)

// SeedDev inserts apps only, referencing the stable DIRECTORY_DEV_SEED IDs.
// Directory owns these identities and groups; legacy console tables stay read-only.
func (s *Store) SeedDev(ctx context.Context) error {
	return s.Do(ctx, true, func(tx *Tx) error {
		var populated bool
		if err := tx.SQL.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM apps)`).Scan(&populated); err != nil {
			return err
		}
		if populated {
			return nil
		}
		admin := domain.Person{ID: "c4f812ff-7cc2-5ceb-92c3-bb26f9a809d8"}
		member := domain.Person{ID: "1c05073e-c5ed-5fd1-8a05-5827bdb45235"}
		east := domain.Group{ID: "2d2e90fc-fb13-526e-828a-56f07275b9f5"}
		operations := domain.Group{ID: "1ea0201e-587f-5f22-ba0f-07eecc673412"}
		for _, item := range []struct {
			group                    domain.Group
			name, slug, scope, guide string
			capabilities             []string
			comment                  string
		}{
			{east, "見積作成", "estimates", "group",
				"## 見積書を作る\n\n1. お客さまと商品を選びます。\n2. 数量と金額を確認します。\n3. 見積書を PDF で出します。",
				[]string{"見積書を PDF で出せる", "過去の見積を検索できる"}, "見積書に担当者の名前も入れたいです。"},
			{operations, "社内申請", "requests", "company",
				"## 申請する\n\n1. 手続きの種類を選びます。\n2. 必要な内容を書きます。\n3. 内容を確認して送ります。",
				[]string{"社内の手続きを申請できる", "申請の進み具合を確認できる"}, "申請の手順が分かりやすいです。"},
		} {
			name := item.slug
			app := domain.App{ID: uuid.NewString(), Slug: item.slug, DisplayName: item.name, Description: "ローカル試用用の下書き", Tags: []string{}, AppName: &name,
				Group: domain.AppGroup{ID: item.group.ID}, CreatedBy: admin,
				Guide: item.guide, Capabilities: item.capabilities,
				Share: domain.SharePolicy{Scope: item.scope, GroupIDs: []string{item.group.ID}, ExtraPersonIDs: []string{}}}
			if err := tx.CreateApp(app); err != nil {
				return err
			}
			// These remain real drafts until the developer binds a platform app;
			// the directory and comment APIs must not bypass that gate for seed data.
			if _, err := tx.CreateComment(app.ID, member.ID, item.comment); err != nil {
				return err
			}
			if _, err := tx.CreateComment(app.ID, admin.ID, "ご意見ありがとうございます。使いやすくなるように直していきます。"); err != nil {
				return err
			}
		}
		return nil
	})
}
