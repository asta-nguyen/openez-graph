namespace Acme
{
    public class Base { public void Inherited() { } }
    public class Helper { public void Work() { } }
    public class C : Base
    {
        public void M(int x) { }
        public void M(string s) { }
        public void Other() { }
        public void Run(Helper h)
        {
            M(1);
            Other();
            h.Work();
            Inherited();
            External.Call();
        }
    }
}
