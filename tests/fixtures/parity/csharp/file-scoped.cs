using Acme.Util;
namespace Acme.Scoped;

public class S
{
    public void Run()
    {
        Helper.Add(1, 2);
        this.Step();
    }
    private void Step() { }
}
