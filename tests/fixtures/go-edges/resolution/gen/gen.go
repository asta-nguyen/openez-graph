package gen

func F[T any](v T) T { return v }

func M[K comparable, V any](k K, v V) V { return v }

func helper() int { return 1 }
