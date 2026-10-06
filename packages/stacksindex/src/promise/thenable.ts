import { Effect, Predicate } from "effect";

function isProxyable<T>(target: T): target is T & object {
  return Boolean(target) && (typeof target === "object" || typeof target === "function");
}

type PromiseThenParameters = Parameters<Promise<unknown>["then"]>;

/**
 * Wraps an Effect so it can also be awaited as a Promise.
 */
export function toThenable<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> & PromiseLike<A>;

export function toThenable<T>(target: T): T;

export function toThenable<T>(target: T): T {
  if (!isProxyable(target)) {
    return target;
  }

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "then" && Effect.isEffect(t)) {
        // SAFETY: Effects reachable through toThenable are self-contained, so they carry no remaining requirements at run time.
        const runnable = t as Effect.Effect<unknown, unknown>;

        return (resolve: PromiseThenParameters[0], reject: PromiseThenParameters[1]) =>
          Effect.runPromise(runnable).then(resolve, reject);
      }

      // SAFETY: The Proxy get trap receives the property key being read from the target `t`.
      const orig = t[prop as keyof typeof t];

      if (Predicate.isFunction(orig)) {
        // oxlint-disable-next-line typescript/no-explicit-any
        return function get(this: any, ...args: any[]) {
          const res = orig.apply(this === receiver ? t : this, args);

          return toThenable(res);
        };
      }

      return orig;
    },
  });
}
