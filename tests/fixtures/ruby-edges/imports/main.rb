require_relative "./util"
require_relative "./other.rb"
require_relative "util.md"
require "json"
load "seed.rb"
autoload :Cache, "cache"

# require_relative "ghost"
=begin
require_relative "ghost"
=end

class Main
  def go
    Util.help()
  end
end

__END__
require_relative "ghost"
