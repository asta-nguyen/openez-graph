pub mod util;
pub mod helper;
pub mod shapes;
mod shapes_ext;
pub mod sub;
mod ambiguous;
pub mod callers;
pub mod shadow;
pub mod inline_dup;
pub mod external;

pub use crate::util::run as root_run;

pub fn top_level() {}

pub fn bootstrap() {
    util::run();
}
