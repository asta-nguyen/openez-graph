# Torture parity fixture mirroring the CodeGraph kernel-parity surface:
# class-body DSL calls, mixins, module nesting, visibility, require forms
# including Kernel.require and interpolated paths, .new, &. joins, bare-call
# statements, heredocs, =begin docstrings, and a __END__ trailer.
require "json"
require 'single_quoted'
require File.join("a", "b")
require_relative "./torture_helper"
require_relative("#{computed}/path")
Kernel.require "yaml"
Kernel.require_relative "./kernel_rel"
load "seed.rb"

module Outer
  module Inner
    CONST = 1
  end
end

module Trackable
  def track(event)
    emit(event)
  end
end

class Base
  def inherited_only
    :base
  end
end

class Widget < Base
  include Trackable
  extend Trackable
  prepend Trackable

  before_action :load_widget
  scope :active, -> { where(active: true) }
  delegate :name, to: :owner
  private_class_method :internal

  def initialize(name)
    @name = name
    setup()
  end

  def render
    @widget.draw()
    self.class.build()
    Widget.new().paint()
    ::TopLevel.ping()
    helper&.chain&.deep()
    send(:render)
    public_send("render")
    method_missing(:x)
    eval("1+1")
    const_get("X")
    respond_to?(:z)
    foo
    bar()
    baz 1, 2
    call_me maybe, with: args
  end

  private

  def internal
    :x
  end

  class << self
    def singleton_block_method
      self.inner()
    end
  end
end

module Outer
  class Widget2
    def m
      Outer::Inner::CONST
      ::Outer::Inner
      deep_call()
    end
  end
end

assigned_call = compute_something()
CONST_ASSIGN = 10

heredoc = <<~EOS
  class NotReal
    def ghost
    end
  end
EOS

sql = <<-SQL
  SELECT * FROM t WHERE x = 'class Fake'
SQL

%w[one two].each do |w|
  puts w
end

=begin
class CommentedOut
end
=end

__END__
this trailer is data, not code
