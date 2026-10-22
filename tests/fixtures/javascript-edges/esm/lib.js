export function real() {
  return 1;
}

export function named() {
  return 2;
}

export function nsMember() {
  return 3;
}

export function targetScoped() {
  return 4;
}

export default function defaultFn() {
  return real();
}
