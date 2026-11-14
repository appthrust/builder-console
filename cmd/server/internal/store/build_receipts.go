package store

// AcceptBuildReceipt reserves an HTTP command whose work is already recorded in
// an effect or attempt. It freezes the response without changing the aggregate.
// Call inside Store.Do(ctx, true, ...); external I/O must follow its commit.
func (t *Tx) AcceptBuildReceipt(scope BuildAccess, session string, expected int64, receipt BuildReceipt) (BuildResult, error) {
	// Serialize both first acceptance and replay with other session writers. The
	// row lookup also hides receipts from callers outside the current group set.
	a, err := t.buildAggregate(scope, session, true)
	if err != nil {
		return BuildResult{}, err
	}
	old, replay, hash, err := t.receipt(scope, session, receipt)
	if err != nil || replay {
		return BuildResult{Aggregate: old, Replay: replay}, err
	}
	if err := checkBuildVersion(a.Session, expected); err != nil {
		return BuildResult{}, err
	}
	if err := t.saveBuildReceipt(scope, session, receipt, hash, a); err != nil {
		return BuildResult{}, err
	}
	return BuildResult{Aggregate: a}, nil
}

// ReplayBuildReceipt permits replay before rendering a new prompt or inspecting
// an external draft. Absence does not reserve a key; the accepting mutation still
// checks it under its transaction and records the first answer atomically.
func (t *Tx) ReplayBuildReceipt(scope BuildAccess, session string, receipt BuildReceipt) (BuildResult, error) {
	if session != "" {
		if _, err := t.BuildSession(scope, session); err != nil {
			return BuildResult{}, err
		}
	}
	a, replay, _, err := t.receipt(scope, session, receipt)
	return BuildResult{Aggregate: a, Replay: replay}, err
}
