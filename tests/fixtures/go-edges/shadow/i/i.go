package i

func Run(t int) int {
	init := func() int { return t }
	return init()
}
