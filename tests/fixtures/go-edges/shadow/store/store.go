package store

type Store struct{}

func Get(k string) int { return len(k) }
