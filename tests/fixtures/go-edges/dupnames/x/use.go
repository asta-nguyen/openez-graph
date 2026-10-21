package x

func Other() int { return 0 }

func Use() int {
	_ = Tagged()
	return Other()
}
