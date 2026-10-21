from . import sibling
from ..pkg import tool
from . import first as renamed, second
from .. import up
import os.path


def run():
    sibling.go()
    tool.run()
    renamed()
    second()
    up()
