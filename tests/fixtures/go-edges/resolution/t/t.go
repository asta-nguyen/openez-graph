package t

type T struct{}

func (t T) helper() int { return 1 }

func Run() int { return helper() }
