namespace n { void a() { f(); } void b() { g(); } }
struct S { int x() { return h(); } int y() { return h(); } };
int f() { return 0; }
int g() { return 0; }
int h() { return 0; }
