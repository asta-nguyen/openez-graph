package d

const (
	Alpha = 1
	Beta  = 2
)

var (
	sharedF = newF("shared")
	sharedG = newG(sharedF)
)

// F and G both declare Close on purpose: resolving which Close a call targets
// requires receiver type inference.
type F struct{ name string }

func (f *F) Close() error { return nil }

type G struct{ f *F }

func (g *G) Close() error { return g.f.Close() }

func newF(name string) *F { return &F{name: name} }

func newG(f *F) *G { return &G{f: f} }

func Map[T any](v T) T { return v }

func useG() {
	f := newF("x")
	g := newG(f)
	defer g.Close()
	g.f.Close()
	_ = Map[int](1)
	var a, b = f, g
	_, _ = a.Close(), b.Close()
}
