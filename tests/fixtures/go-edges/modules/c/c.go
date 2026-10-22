package c

import "example.com/fake"

func C() int {
	_ = fake.F()
	return 0
}
