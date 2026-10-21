package imp

import (
	"github.com/x/pb/v3"
	v3 "example.com/impmod/client/v3"
)

func B() int { return v3.Do() }
