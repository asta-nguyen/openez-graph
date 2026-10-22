use crate::shapes::{Circle, Pair};
use crate::helper::tool as renamed_tool;
use crate::ambiguous;

pub fn run() {}

pub fn call_sites() {
    run();
    crate::util::run();
    crate::root_run();
    util::run();
    Circle::new(3.0);
    renamed_tool();
    ambiguous::thing();
    let x = Circle::new(4.0);
    x.draw();
    let _m = std::collections::HashMap::new();
    let _p = Pair(5, 6);
    let _v = [1].iter().map(|v| v + 1).collect::<Vec<_>>();
}
