#include "edge.h"
#include <map>

namespace edge {

struct Node {
  void touch();
  Node* left;
};

void Node::touch() {}

int walk(Node* n) {
  if (n == nullptr) return 0;
  n->touch();
  n->left = nullptr;
  return 1;
}

class Tree {
public:
  int depth() { return walk(root); }
private:
  Node* root;
};

}  // namespace edge
