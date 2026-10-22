use crate::util::{self, run as go};
use super::helper::{self, tool, other as o};

mod util {
    fn run() {}
}

struct Circle;
impl Circle {
    fn new() -> Circle { Circle }
    fn draw(&self) {}
}

fn parse<T>(s: &str) -> T { todo!() }

fn main() {
    crate::util::run();
    util::run();
    go();
    let x = Circle::new();
    x.draw();
    Self::check();
    let v = parse::<u8>("1");
    let w = x.method::<Vec<u8>>();
    helper::tool();
}
