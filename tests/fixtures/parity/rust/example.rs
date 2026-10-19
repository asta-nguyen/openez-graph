use std::collections::HashMap;
use std::fmt;

pub struct Greeter {
    prefix: String,
}

pub trait Drawable {
    fn draw(&self);
}

impl Greeter {
    pub fn new(prefix: &str) -> Self {
        Greeter { prefix: prefix.to_string() }
    }

    pub fn greet(&self, name: &str) -> String {
        format_greeting(&self.prefix, name)
    }
}

impl Drawable for Greeter {
    fn draw(&self) {
        render(self.greet("x"));
    }
}

impl fmt::Display for Greeter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Greeter({})", self.prefix)
    }
}

fn format_greeting(prefix: &str, name: &str) -> String {
    format!("{} {}", prefix, name)
}

fn render(s: String) {
    println!("{}", s);
}

fn factorial(n: u32) -> u32 {
    if n <= 1 {
        1
    } else {
        n * factorial(n - 1)
    }
}

fn main() {
    let g = Greeter::new("Dr.");
    render(g.greet("Watson"));
    let mut map = HashMap::new();
    map.insert("k", factorial(3));
}
