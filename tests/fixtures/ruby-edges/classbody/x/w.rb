class Widget
  helper()
  def self.helper
    :ok
  end
end

class Outer
  helper()
end

class Shape
  Sub.ping()
  class Sub
    def self.ping
      :p
    end
  end
end

module Mod
  helper()
  def self.helper
    :ok
  end
end

def helper
  :top
end
