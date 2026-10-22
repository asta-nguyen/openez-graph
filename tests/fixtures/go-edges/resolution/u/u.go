package u

import "example.com/resmod/gen"

func Use() int {
	a := gen.F[int](1)
	b := gen.M[int, string](1, "x")
	_ = gen.helper()
	return a + b
}
