from pkg import (
    alpha,
    beta as bee,
    gamma,
)
from other import one, \
    two as dos
import a.b, c as see


def main():
    alpha()
    bee()
    gamma()
    one()
    dos()
    a.b.go()
    see.run()
