namespace Acme.Consumer
{
    using Util;
    using static More.St;
    public class C
    {
        public void Run() { Helper.Add(1, 2); Twice(3); Inst(3); }
    }
}
namespace Acme.Other
{
    public class D
    {
        public void Go() { Helper.Add(1, 2); Twice(3); }
    }
}
