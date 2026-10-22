using Acme.Util;
namespace Acme.Core
{
    public partial class Widget
    {
        public void Run()
        {
            Step();
            this.Step();
            Helper.Add(1, 2);
        }
        private void Step() { }
    }
}
