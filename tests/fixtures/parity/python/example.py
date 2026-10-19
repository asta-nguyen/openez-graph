import os
import sys as system
from typing import List
from .utils import helper

CONSTANT = 1


def decorator(fn):
    return fn


@decorator
def hello(name: str) -> str:
    return f"Hello, {name}"


class Greeter:
    def __init__(self, prefix: str):
        self.prefix = prefix

    def greet(self, name: str) -> str:
        return hello(f"{self.prefix} {name}")


def factorial(n: int) -> int:
    if n <= 1:
        return 1
    return n * factorial(n - 1)


def main():
    g = Greeter("Dr.")
    print(g.greet("Watson"))
    result = factorial(5)
    helper(os.getcwd())
