import { Effect, Predicate } from "effect";

function isProxyable<T>(target: T): target is T & object {
  return Boolean(target) && (typeof target === "object" || typeof target === "function");
}

type PromiseThenParameters = Parameters<Promise<unknown>["then"]>;

/** Runs an awaited Effect; defaults to `Effect.runPromise` with an empty context. */
export type ThenableRunner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

const runWithoutServices: ThenableRunner = (effect) => Effect.runPromise(effect);

/**
 * Drizzle exposes relational query builders as plain properties
 * (`db.query.<table>.findMany()`), not method results, so this subtree is
 * wrapped property by property.
 */
const RELATIONAL_QUERY_PROPERTY = "query";

/**
 * Wraps an Effect so it can also be awaited as a Promise.
 *
 * `run` executes awaited Effects. Pass `Effect.runPromiseWith(services)` to
 * keep the caller's services, e.g. the open transaction connection.
 */
export function toThenable<A, E>(
  effect: Effect.Effect<A, E>,
  run?: ThenableRunner,
): Effect.Effect<A, E> & PromiseLike<A>;

export function toThenable<T>(target: T, run?: ThenableRunner): T;

export function toThenable<T>(target: T, run: ThenableRunner = runWithoutServices): T {
  return wrap(target, run, false);
}

function wrap<T>(target: T, run: ThenableRunner, wrapProperties: boolean): T {
  if (!isProxyable(target)) {
    return target;
  }

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "then" && Effect.isEffect(t)) {
        // SAFETY: Effects reachable through toThenable are self-contained or need only the services `run` provides.
        const runnable = t as Effect.Effect<unknown, unknown>;

        return (resolve: PromiseThenParameters[0], reject: PromiseThenParameters[1]) =>
          run(runnable).then(resolve, reject);
      }

      // SAFETY: The Proxy get trap receives the property key being read from the target `t`.
      const orig = t[prop as keyof typeof t];

      if (Predicate.isFunction(orig)) {
        // A proxy rather than a wrapper function keeps the function's own
        // Properties, e.g. the SQL client's `reserve` under `db.$client`.
        return new Proxy(orig, {
          apply(fn, thisArg, args) {
            return wrap(fn.apply(thisArg === receiver ? t : thisArg, args), run, false);
          },
        });
      }

      if (!wrapProperties && prop !== RELATIONAL_QUERY_PROPERTY) {
        return orig;
      }

      // A read-only, non-configurable property must be returned as is (Proxy invariant).
      const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);

      if (descriptor?.configurable === false && descriptor.writable === false) {
        return orig;
      }

      return wrap(orig, run, true);
    },
  });
}
