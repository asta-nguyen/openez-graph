package imp

import (
	v3 "example.com/impmod/client/v3"
	"github.com/x/pb/v3"
)

func A() int { return v3.Do() + v3.Ändern() }
