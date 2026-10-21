# Broad parity fixture: Ruby symbol, import, and call surface.
require "json"
require "net/http"
require_relative "./helper"
require_relative('lib/util')
Kernel.require "yaml"
Kernel.require_relative "./kernel_rel"
require_relative "#{dir}/dynamic"
load "seed.rb"
autoload :Cache, "cache"

module Billing
  # A class with nesting, singletons, DSL calls, and a reopening below.
  class Invoice
    include Comparable
    extend Forwardable
    attr_accessor :number
    validates :number, presence: true
    has_many :line_items
    before_save :recalculate

    def self.build(attrs)
      Helper.run(attrs)
      new
    end

    def total
      self.tax
      other.tax
      helper_fn(1)
      Invoice.build
      Billing::Invoice.build({})
      user&.name
      items.each { |i| i.price }
    end

    def tax
      0.1
    end

    private

    def secret
      :hidden
    end

    class << self
      def audit
        log_audit()
      end
    end
  end

  # Reopened class: adds a second symbol with the same label.
  class Invoice
    def reopened_method
      compute()
    end
  end

  module Helper
    def self.run(attrs)
      attrs
    end
  end
end

class Invoice
  def top_level_method
  end
end

handler = lambda { |x| x * 2 }
handler2 = ->(x) { x }
processor = proc { |y| y }
callback = Proc.new { work() }
plain = 42

def helper_fn(x)
  x
end

LONG_TEXT = <<~TEXT
  def fake_method
    not_a_symbol
  end
TEXT

=begin
def commented_out
end
=end

__END__
trailer data ignored
