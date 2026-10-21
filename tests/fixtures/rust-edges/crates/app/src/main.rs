use app::helper::tool;
use app::util::run as lib_run;

fn main() {
    lib_run();
    tool();
    crate::local_fn();
    app::shapes::paint();
}

fn local_fn() {}
