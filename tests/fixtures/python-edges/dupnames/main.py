from pkg1.util import unique_one
from pkg2.util import helper as helper2
from pkg1 import util
import pkg2.util


def local_target():
    return None


def run():
    unique_one()
    helper2()
    util.helper()
    pkg2.util.helper()
    ambiguous()
    local_target()
