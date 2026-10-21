#include "util.h"
#include <vector>

namespace app {

class Worker {
public:
  void run();
  int status();
private:
  int count;
};

int helper(int v) { return v + 1; }

void Worker::run() {
  status();
  this->count = helper(1);
}

int Worker::status() { return count; }

}  // namespace app

int free_function() { return app::helper(2); }
