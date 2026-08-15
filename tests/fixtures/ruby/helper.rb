require_relative "./user"

module Helper
  def self.process(user)
    user.greet("World")
  end
end
