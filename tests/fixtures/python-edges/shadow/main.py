from helpers import project_view, X


def local_target():
    return None


def run(param_target):
    view = X.as_view()
    view(request)
    for loop_target in items:
        loop_target()
    with open_ctx() as ctx_name:
        ctx_name()
    param_target()
    project_view()
    X()
    local_target()


def run_local():
    project_view = X.as_view()
    project_view(request)
