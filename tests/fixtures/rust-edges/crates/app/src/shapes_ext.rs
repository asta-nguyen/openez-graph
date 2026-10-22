use crate::shapes::Circle;

impl Circle {
    pub fn describe(&self) {
        self.draw();
        let _c = Self::new(0.0);
    }
}
