package p

import "example.com/shadowmod/store"

func Handle(store *store.Store) int {
	return store.Get("k")
}

func Closure() int {
	call := func(store, other *store.Store) int {
		return store.Get("k") + other.Get("k")
	}
	return call(nil, nil)
}
