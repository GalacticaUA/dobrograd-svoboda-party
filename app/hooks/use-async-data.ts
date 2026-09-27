"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ActionResult } from "@/lib/auth/actions";

interface AsyncState<T> {
  data: T | null;
  error: string | null;
  pending: boolean;
}

/**
 * Load a tab's data on mount, and expose a `refresh` for after mutations.
 *
 * Each portal tab fetches itself rather than receiving everything during the page
 * render, because the portal is a modal the user opens deliberately: shipping all
 * nine tabs' rows to the browser up front would mean paying for the registry, the
 * map and the audit log before the user has looked at any of them.
 *
 * `loader` is held in a ref rather than listed as an effect dependency. Inline
 * arrow functions are recreated on every render, and depending on the loader's
 * identity directly would restart the request in an infinite loop. The ref is
 * written from an effect, never during render. A caller that needs parameters
 * should wrap its loader in `useCallback` and pass `key` so the effect re-runs when
 * the parameter actually changes.
 *
 * Reloading is driven by a `nonce` counter instead of a fetch function called from
 * the effect. `refresh` then only has to set state, and the effect's first state
 * write happens inside a promise callback rather than synchronously in the effect
 * body — which is what keeps this off the "cascading render" path. The initial
 * `pending` is already `true`, so the mount pass never needs a `setPending(true)`.
 */
export function useAsyncData<T>(
  loader: () => Promise<ActionResult<T>>,
  key?: string,
) {
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, pending: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    loaderRef.current().then(
      (result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { data: result.data, error: null, pending: false }
            : { data: null, error: result.error, pending: false },
        );
      },
      (cause: unknown) => {
        if (cancelled) return;
        // A thrown Server Action means the network or the server died, not that the
        // user did something wrong, so it gets a distinct message from a rejection.
        console.error("[portal] loader threw:", cause);
        setState({ data: null, error: "Не удалось загрузить данные. Проверьте соединение.", pending: false });
      },
    );

    // On unmount, or on a re-run, the in-flight result is discarded rather than
    // written into a component that is gone or is now showing a different `key`.
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  const refresh = useCallback(() => {
    setState((previous) => ({ ...previous, pending: true, error: null }));
    setNonce((value) => value + 1);
  }, []);

  const setData = useCallback((value: T) => {
    setState((previous) => ({ ...previous, data: value, error: null }));
  }, []);

  return { ...state, refresh, setData };
}
