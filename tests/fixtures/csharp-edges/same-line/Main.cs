class Program
{
    static void Main()
    {
        A.Worker.RunA();
        B.Worker.RunB();
        A.Worker.Shared();
        B.Worker.Shared();
        C.Missing.Go();
    }
}
