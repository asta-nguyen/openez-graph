import { describe, expect, it } from "bun:test";

import { parseRuby } from "../packages/indexer/src/languages";

describe("parseRuby regex fallback", () => {
  it("extracts class, module, and method symbols", () => {
    const result = parseRuby(`
module MyApp
  class User
    def greet(name)
      puts "Hello, \#{name}"
    end

    def self.admin?
      true
    end
  end
end
`);

    const names = result.definedSymbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["MyApp", "MyApp::User", "MyApp::User::greet", "MyApp::User::admin?"]),
    );
    const user = result.definedSymbols.find((s) => s.name === "MyApp::User");
    expect(user?.symbolType).toBe("class");
    const greet = result.definedSymbols.find((s) => s.name === "MyApp::User::greet");
    expect(greet?.symbolType).toBe("function");
    expect(greet?.exported).toBe(false);
  });

  it("keeps following methods nested after a one-line definition", () => {
    const result = parseRuby(`
class User
  def first; end
  def second; end
end
`);

    expect(result.definedSymbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["User::first", "User::second"]),
    );
  });

  it("extracts require_relative imports only", () => {
    const result = parseRuby(`
require "rails"
require_relative "./user"
load "helper.rb"
autoload :Cache, "cache"

class App
end
`);

    expect(result.importPaths).toEqual(["./user"]);
    expect(result.importPaths).not.toContain("rails");
    expect(result.importPaths).not.toContain("helper.rb");
    expect(result.importPaths).not.toContain("cache");
  });

  it("does not produce false call edges in regex fallback", () => {
    const result = parseRuby(`
class User
  def save
    user.name
    validate
  end
end
`);

    expect(result.callExpressions).toEqual([]);
    expect(result.calledIdentifiers).toEqual([]);
  });
});
