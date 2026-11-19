package buildsession

import (
	"context"
	"errors"
	"net/http"
)

// ConsoleStack is the Platform ownership evidence used by the console proxy.
// The public SDK stack reader currently omits databaseComponentId.
type ConsoleStack struct {
	ID                  string `json:"id"`
	ApplicationID       string `json:"applicationId"`
	BranchID            string `json:"branchId"`
	WebComponentID      string `json:"webComponentId"`
	DatabaseComponentID string `json:"databaseComponentId"`
}

func (c *Client) ConsoleStack(ctx context.Context, bearer, id string) (ConsoleStack, error) {
	var stack ConsoleStack
	path, err := resourcePath(c.prefix+"/application-stacks", id)
	if err != nil {
		return stack, err
	}
	if _, err := c.json(ctx, bearer, http.MethodGet, path, "", "", nil, &stack); err != nil {
		return stack, err
	}
	if stack.ID != id {
		return stack, errors.New("platform stack ownership response has an unexpected stack ID")
	}
	return stack, nil
}
