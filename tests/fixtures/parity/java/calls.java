package app.calls;

import app.demo.Outer;
import static app.demo.Outer.helper;

interface Greeter {
    void greet();
}

enum Level {
    LOW {
        void run() {
            tick();
        }
    },
    HIGH;

    void tick() {
    }
}

record Point(int x, int y) {
    Point {
        normalize();
    }

    void normalize() {
    }
}

public class Calls {
    private final String name = "x";

    public static void main(String[] args) {
        Calls c = new Calls();
        c.work();
        c.name.toString();
        Outer o = null;
        o.m();
        getCalls().work();
        Runnable r = new Runnable() {
            public void run() {
                suppressed();
                this.alsosuppressed();
                Outer.Inner.staticCall();
            }
        };
        r.run();
        java.util.Objects.requireNonNull(r);
    }

    static Calls getCalls() {
        return new Calls();
    }

    void work() {
        int local = 0;
        local++;
        class Local {
            void inside() {
                work2();
            }
        }
        Runnable lambda = () -> work2();
        lambda.run();
    }

    void work2() {
    }

    static {
        boot();
    }

    static void boot() {
    }
}
