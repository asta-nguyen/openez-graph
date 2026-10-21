pub fn run() {}

pub fn compute(x: i32) -> i32 {
    x
}

pub fn helper() {}

pub fn shadow_test() {
    let run = |v: i32| v;
    run(1);
    let compute = |v: i32| v * 2;
    compute(2);
}

pub fn param_shadow(run: i32) {
    run();
}

pub fn closure_param() {
    let f = |run: i32| run;
    f(1);
    run();
}

pub fn for_shadow() {
    for run in 0..3 {
        run();
    }
}

pub fn iflet_shadow(o: Option<i32>) {
    if let helper = o {
        helper();
    }
}

pub fn match_shadow(o: Option<i32>) -> i32 {
    match o {
        helper => helper,
        _ => 0,
    }
}

pub fn match_shadow_call() {
    let o = Some(1);
    match o {
        helper => println!("{helper}"),
        _ => (),
    }
    helper();
}
