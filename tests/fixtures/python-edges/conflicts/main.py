try:
    import real_a as jlib
except ImportError:
    import real_b as jlib

import real_a
import real_c


def dup():
    pass


def dup():
    pass


def local_target():
    return None


def f():
    import real_b as real_a
    real_a.go()


def g():
    real_a.go()
    jlib.go()
    local_target()


def caller_dup():
    dup()


def ok():
    real_c.act()
