module Billing
  class Invoice
    def self.build
      Helper.run
    end

    def total
      self.tax
      Invoice.build
      Billing::Invoice.build
      Helper.run
      make_id()
      audit()
      other.tax
      user&.name
      @client.get()
    end

    def tax
      0
    end

    def audit
      :instance
    end

    class << self
      def audit
        emit()
      end
    end
  end

  module Helper
    def self.run
      log()
    end
  end
end

def make_id
  :id
end

def emit
  :emit
end

def log
  :log
end
