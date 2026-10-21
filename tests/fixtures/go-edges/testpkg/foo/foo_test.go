package foo_test

import "example.com/testmod/foo"

func helper() int { return 1 }

func TestNew() int { return foo.New() + helper() }
