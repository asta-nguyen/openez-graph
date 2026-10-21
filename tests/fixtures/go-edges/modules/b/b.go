package b

import "example.com/rootx"

func local() int { return 1 }

func B() int {
	_ = rootx.F()
	return local()
}
