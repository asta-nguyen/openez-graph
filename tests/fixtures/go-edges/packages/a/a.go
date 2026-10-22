package a

// T is the public handle produced by New.
type T struct{ id int }

// New constructs a T, relying on the same-package helper in helper.go.
func New() *T {
	seed := helper()
	return &T{id: seed}
}
