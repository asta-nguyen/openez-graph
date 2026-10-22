mod a {
    pub fn dup() {}

    pub struct S;

    impl S {
        pub fn f(&self) {}
    }
}

mod b {
    pub fn dup() {}

    pub struct S;

    impl S {
        pub fn f(&self) {}
    }
}

pub fn caller() {
    dup();
    let _s = S;
    S::f();
}
