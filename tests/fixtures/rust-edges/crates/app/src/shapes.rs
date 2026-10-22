pub struct Circle {
    r: f64,
}

pub struct Pair(pub i32, pub i32);

pub trait Shape {
    fn area(&self) -> f64;
}

fn paint() {}

impl Circle {
    pub fn new(r: f64) -> Circle {
        Circle { r }
    }

    pub fn draw(&self) {
        paint();
    }

    fn helper_method(&self) {}
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        self.draw();
        self.helper_method();
        let _c = Self::new(0.0);
        let _p = Pair(1, 2);
        0.0
    }
}
