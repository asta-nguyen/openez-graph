use super::sub_helper;
use super::*;
use crate::helper::{self, other as o, tool};
use crate::shapes::{self, Circle};

pub fn go() {
    sub_helper();
    globbed();
    super::sub_helper();
    self::go2();
    crate::util::run();
    helper::tool();
    tool();
    o();
    shapes::Circle::new(0.0);
    Circle::new(1.0);
    let c = Circle::new(2.0);
    c.draw();
    run();
    let _s = Some(1);
    let _o = Ok(2);
}

fn go2() {}
