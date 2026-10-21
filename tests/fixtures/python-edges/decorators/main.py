import helpers

app = Something()


@app.route("/x")
def route_handler():
    pass


@helpers.cached
def wrapped():
    pass


class K:
    @helpers.cached
    def method(self):
        pass
