class Service
  def run
    @repo.fetch()
    user.name()
    result&.dig()
    send(:run)
    public_send("run")
    method_missing(:x)
    eval("x")
    const_get("Y")
    respond_to?(:z)
    Child.build()
    Helper.run()
  end
end

class Parent
  def build
    :parent
  end
end

class Child < Parent
end

module Helper
  def self.run
    :run
  end
end
