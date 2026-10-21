package app;

public class Outer {
    public void caller() {
        helper();
        this.local();
    }

    void helper() {
    }

    void local() {
    }

    public static class Inner {
        public void m() {
            helper();
            this.deep();
        }

        void deep() {
        }

        static void staticCall() {
        }
    }
}
