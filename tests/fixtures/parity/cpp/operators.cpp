struct A {
  int operator<<(int);
  bool operator<(const A&);
};
int A::operator<<(int x) { return x; }
bool A::operator<(const A& o) { return true; }
int g() { return A::operator<<(1); }
bool h(A& a, A& b) { return A::operator<(a, b); }
