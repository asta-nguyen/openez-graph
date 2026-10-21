using Acme.Util;
using H = Acme.Util.Helper;
using static Acme.Util.Math2;
using X = External.Widget;
using Acme.Missing;
namespace Acme.Consumer
{
    public class C
    {
        public void Run()
        {
            Helper.Add(1, 2);
            H.Sub(1, 2);
            Sq(3);
            X.Make();
            Missing.Do();
        }
    }
}
