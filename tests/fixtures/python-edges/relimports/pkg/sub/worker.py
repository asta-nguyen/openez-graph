from . import deep
from .. import sibling
from ..sibling import sibling_fn
from .deep import deep_fn as df


def local_target():
    return None


def use():
    deep.deep_fn()
    sibling.sibling_fn()
    sibling_fn()
    df()
    missing()
    local_target()
