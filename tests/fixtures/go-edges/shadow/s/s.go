package s

import "example.com/shadowmod/store"

func newStore() int { return 0 }

func Use(k string) int {
	store := newStore()
	return store.Get(k)
}
