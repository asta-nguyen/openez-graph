class User
  def greet(name)
    puts "Hello, #{name}"
  end

  def self.admin?
    true
  end

  class << self
    def bulk_create(users)
      users.map { |u| u }
    end
  end
end
