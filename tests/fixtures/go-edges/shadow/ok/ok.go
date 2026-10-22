package ok

import "example.com/shadowmod/store"

func Ok(k string) int { return store.Get(k) }
