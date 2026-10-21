package main

import (
	"example.com/dep"
	"example.com/vendmod/p"
)

func main() {
	dep.Work()
	p.Ping()
}
