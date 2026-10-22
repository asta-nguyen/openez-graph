using Alpha.Util;
global using Beta.Common;
using H = Alpha.Util.Helper;
using static Alpha.Util.Math2;

namespace Alpha.Util
{
    public static class Helper
    {
        public static int Add(int a, int b) => a + b;
        private static int _seed = 7;
        public static string Name { get; set; } = "h";
        public Helper() { }
        ~Helper() { }
    }
    public static class Math2 { public static int Sq(int x) => x * x; }
    public struct Point { public int X, Y; }
    public interface IRun { void Run(); }
    public record Rec(int X);
    public enum Color { Red, Blue }
    public delegate void Done(int x);
}

namespace App.Core
{
    using Inner.Util;
    using Z = Alpha.Util.Helper;
    public partial class Widget
    {
        public void Run()
        {
            Step();
            this.Step();
            Helper.Add(1, 2);
            Sq(3);
            H.Add(2, 3);
            Gen<Dict<string, int>>.Build();
            obj?.Maybe();
        }
        private void Step() { }
        public class Nested { public void P() { Local(); } }
    }
    public partial class Widget
    {
        public void Extra() { Run(); }
    }
}

namespace Conditional
{
    public class Both
    {
#if DEBUG
        public void Target() { }
#else
        public void Target() { }
#endif
        public void Other() { }
    }
}
