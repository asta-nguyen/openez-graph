namespace calc {

template <typename T>
T maximum(T a, T b) {
  return a < b ? b : a;
}

struct Box {
  int value;
  Box* next;
};

enum class Level { Low, High };

union Data {
  int i;
  float f;
};

typedef unsigned int Count;
using Index = int;

int compute() {
  Data d;
  d.i = 3;
  return maximum<int>(d.i, 4);
}

}  // namespace calc
