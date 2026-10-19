package b

// U mirrors a.T but lives in a different package.
type U struct{ id int }

// New constructs a U using this file's own helper (same-file lookup).
func New() *U {
	seed := helper()
	return &U{id: seed}
}

// helper intentionally collides with a.helper.
func helper() int {
	return 7
}
