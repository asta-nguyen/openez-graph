package imp

import (
	// "fake.io/notanimport"
	"example.com/impmod/client/v3" // trailing "fake.io/also"
	_ "example.com/impmod/client/v3"
)

var doc = `import "fake.io/raw"`

func D() int { return clientv3.Do() }
