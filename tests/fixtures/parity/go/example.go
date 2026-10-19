package main

import (
	"fmt"
	"strings"
)

type Stack[T any] struct {
	items []T
}

func (s *Stack[T]) Push(item T) {
	s.items = append(s.items, item)
}

func (s Stack[T]) Peek() T {
	return s.items[len(s.items)-1]
}

type Greeter struct {
	prefix string
}

func (g *Greeter) Greet(name string) string {
	return formatGreeting(g.prefix, name)
}

func (g Greeter) Prefix() string {
	return g.prefix
}

func formatGreeting(prefix, name string) string {
	return fmt.Sprintf("%s %s", prefix, name)
}

func factorial(n int) int {
	if n <= 1 {
		return 1
	}
	return n * factorial(n-1)
}

type Node struct {
	next *Node
}

func (n *Node) Traverse() {
	if n.next != nil {
		n.next.Traverse()
	}
}

func main() {
	g := &Greeter{prefix: "Dr."}
	fmt.Println(g.Greet("Watson"))
	s := Stack[int]{}
	s.Push(1)
	s.Peek()
	_ = strings.TrimSpace(" x ")
}
