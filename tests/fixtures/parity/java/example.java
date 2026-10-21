package app.demo;

import app.util.Util;
import static app.util.Util.format;
import java.util.List;
import java.util.*;

public class Outer {
    private int count;

    public Outer() {
        this.count = 0;
    }

    public void caller() {
        helper();
        this.local();
        Util.format();
        format();
        app.util.Util.format();
        count += 1;
    }

    void helper() {
    }

    void local() {
    }

    public static class Inner {
        public void m() {
            deep();
        }

        void deep() {
        }
    }
}

class Sibling {
    void s() {
    }
}

@Doc("public API")
class AnnotatedHidden {
    @Doc("public method")
    void hidden() {
    }
}

@Doc("internal")
public class AnnotatedShown {
    @Doc("public field")
    public void shown() {
    }
}
