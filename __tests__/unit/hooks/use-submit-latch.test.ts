/** @jest-environment jsdom */
/**
 * `hooks/use-submit-latch.ts` — THE SHARED SUBMIT LATCH (reconciliation Part 2,
 * pack § P2-B3-1R, M-a.1).
 *
 * One write per Confirm, and no dismissal while it is in flight. The REF is the
 * truth and is set SYNCHRONOUSLY when `run` is called (B3-1 FD3-1: the render
 * lags the click); `busy` mirrors it for rendering. Both release in `finally`,
 * so a failed write releases too (FD4-1). The success close inside `fn` goes
 * through the host's RAW callback — through the guard it would be dropped.
 */

import { act, renderHook } from "@testing-library/react";

import { useSubmitLatch } from "@/hooks/use-submit-latch";

/** A promise the test settles by hand — the write "in flight". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSubmitLatch", () => {
  it("runs fn and resolves to its result", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    let answer: string | undefined;
    await act(async () => {
      answer = await result.current.run(async () => "written");
    });
    expect(answer).toBe("written");
  });

  it("calls fn synchronously, in the caller's own task (the request starts with the click)", () => {
    const { result } = renderHook(() => useSubmitLatch());
    const write = deferred<void>();
    const fn = jest.fn(() => write.promise);

    let pending!: Promise<void | undefined>;
    act(() => {
      pending = result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    return act(async () => {
      write.resolve();
      await pending;
    });
  });

  it("a second run while the first holds the latch → undefined, and its fn is never called", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    const write = deferred<string>();
    const first = jest.fn(() => write.promise);
    const second = jest.fn(async () => "second write");

    let firstRun!: Promise<string | undefined>;
    let secondAnswer: string | undefined = "not yet";
    await act(async () => {
      firstRun = result.current.run(first);
      // Synchronously after the first call — no render in between (FD3-1).
      secondAnswer = await result.current.run(second);
    });
    expect(secondAnswer).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);

    let firstAnswer: string | undefined;
    await act(async () => {
      write.resolve("first write");
      firstAnswer = await firstRun;
    });
    expect(firstAnswer).toBe("first write");
    expect(second).not.toHaveBeenCalled();
  });

  it("a run after the latch releases calls its fn again", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    const fn = jest.fn(async () => "ok");
    await act(async () => {
      await result.current.run(fn);
    });
    await act(async () => {
      await result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("the guard drops `false` while held (from the instant run is called), passes it once released; `true` always passes", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    const host = jest.fn();
    const write = deferred<void>();

    let pending!: Promise<void | undefined>;
    act(() => {
      pending = result.current.run(() => write.promise);
      // The instant window: the ref is held before any render (FD3-1).
      result.current.guardOpenChange(host)(false);
    });
    expect(host).not.toHaveBeenCalled();

    // Still held after the re-render, through a guard built on this render.
    result.current.guardOpenChange(host)(false);
    expect(host).not.toHaveBeenCalled();
    result.current.guardOpenChange(host)(true);
    expect(host.mock.calls).toEqual([[true]]);

    await act(async () => {
      write.resolve();
      await pending;
    });

    result.current.guardOpenChange(host)(false);
    result.current.guardOpenChange(host)(true);
    expect(host.mock.calls).toEqual([[true], [false], [true]]);
  });

  it("a guard built BEFORE the run still reads the live latch (the ref, not a render)", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    const host = jest.fn();
    const guarded = result.current.guardOpenChange(host);
    const write = deferred<void>();

    let pending!: Promise<void | undefined>;
    act(() => {
      pending = result.current.run(() => write.promise);
    });
    guarded(false);
    expect(host).not.toHaveBeenCalled();

    await act(async () => {
      write.resolve();
      await pending;
    });
    guarded(false);
    expect(host.mock.calls).toEqual([[false]]);
  });

  it("finally releases the latch after fn throws, and run rethrows the error", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    const host = jest.fn();
    const failure = new Error("Insufficient stock. Available: 2, Requested: 3");

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.run(async () => {
          throw failure;
        });
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBe(failure);
    expect(result.current.busy).toBe(false);

    // Released: a dismissal passes, and the next Confirm runs.
    result.current.guardOpenChange(host)(false);
    expect(host.mock.calls).toEqual([[false]]);
    const retry = jest.fn(async () => "retried");
    let answer: string | undefined;
    await act(async () => {
      answer = await result.current.run(retry);
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(answer).toBe("retried");
  });

  it("finally releases after fn throws SYNCHRONOUSLY too", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    const host = jest.fn();
    const failure = new Error("thrown before any await");

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.run((() => {
          throw failure;
        }) as () => Promise<void>);
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBe(failure);
    result.current.guardOpenChange(host)(false);
    expect(host.mock.calls).toEqual([[false]]);
  });

  it("a success close inside fn through the RAW callback reaches the host; the same close through the guard is dropped", async () => {
    const { result } = renderHook(() => useSubmitLatch());

    const rawHost = jest.fn();
    await act(async () => {
      await result.current.run(async () => {
        rawHost(false);
      });
    });
    expect(rawHost.mock.calls).toEqual([[false]]);

    const guardedHost = jest.fn();
    await act(async () => {
      await result.current.run(async () => {
        result.current.guardOpenChange(guardedHost)(false);
      });
    });
    expect(guardedHost).not.toHaveBeenCalled();
  });

  it("busy is true while fn is in flight and false after it settles", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    expect(result.current.busy).toBe(false);

    const write = deferred<void>();
    let pending!: Promise<void | undefined>;
    act(() => {
      pending = result.current.run(() => write.promise);
    });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      write.resolve();
      await pending;
    });
    expect(result.current.busy).toBe(false);
  });

  it("busy is false after a FAILED fn too", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    const write = deferred<void>();
    let pending!: Promise<void | undefined>;
    act(() => {
      pending = result.current.run(() => write.promise);
    });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      write.reject(new Error("500"));
      await pending.catch(() => undefined);
    });
    expect(result.current.busy).toBe(false);
  });

  it("run and guardOpenChange keep their identity across renders", async () => {
    const { result } = renderHook(() => useSubmitLatch());
    const { run, guardOpenChange } = result.current;
    await act(async () => {
      await result.current.run(async () => undefined);
    });
    expect(result.current.run).toBe(run);
    expect(result.current.guardOpenChange).toBe(guardOpenChange);
  });
});
