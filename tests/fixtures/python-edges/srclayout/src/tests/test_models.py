import app.models
from app.models import fetch


def local_target():
    return None


def test_it():
    fetch()
    app.models.other()
    local_target()
