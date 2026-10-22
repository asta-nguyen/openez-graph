package imp

import "example.com/impmod/client/v3"

func C() int { return clientv3.Do() }
