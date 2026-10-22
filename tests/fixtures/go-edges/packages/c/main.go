package main

import (
	"fmt"

	"example.com/edgeprobe/a"
	"example.com/edgeprobe/b"
)

func main() {
	ta := a.New()
	tb := b.New()
	fmt.Println(ta, tb)
}
