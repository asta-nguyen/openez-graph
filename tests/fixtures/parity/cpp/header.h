#pragma once

namespace hdr {

struct Item {
  int id;
  int weight();
};

inline int Item::weight() { return id; }

int declared_only(int x);

class Box {
public:
  Box();
  ~Box();
  int size() const;
};

}  // namespace hdr
