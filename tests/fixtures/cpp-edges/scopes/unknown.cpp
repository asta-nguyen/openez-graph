struct Obj { void fire(); };
int u() {
  Obj o;
  o.fire();
  Obj* p = &o;
  p->fire();
  return 0;
}
