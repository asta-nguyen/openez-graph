package app;

public class Anon {
    void helper() {
    }

    public void go() {
        Runnable r = new Runnable() {
            public void run() {
                helper();
                this.helper();
                app.Util.format();
            }
        };
    }
}
