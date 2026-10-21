namespace Acme
{
    public class C
    {
        public void Run() { Target(); Other(); }
#if DEBUG
        private void Target() { }
#else
        private void Target() { }
#endif
        private void Other() { }
    }
}
