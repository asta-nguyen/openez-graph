package app;

public class Use {
    public void run() {
        Outer.Inner.staticCall();
        app.Outer.Inner.staticCall();
    }
}
