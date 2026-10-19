package a

// helper shares its name with b.helper on purpose: resolving which helper a
// call targets requires package awareness.
func helper() int {
	return 42
}
