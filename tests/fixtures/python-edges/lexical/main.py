from other import conflict


def top_helper():
    pass


def conflict():
    pass


def local_target():
    return None


def outer():
    def inner():
        top_helper()

    inner()
    top_helper()
    conflict()
    local_target()


class K:
    def helper_only_class(self):
        pass

    def m(self):
        helper_only_class()
        top_helper()
