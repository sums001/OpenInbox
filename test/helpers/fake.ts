// Routes the Worker's outbound fetch calls to the in-memory API fakes during tests.
import { vi } from 'vitest';
import { createFakeState, handleFake, type FakeState } from '../mock/fake-apis';

export function useFakeApis(): { state: FakeState; reset: () => void } {
  const holder = { state: createFakeState() };
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const res = await handleFake(holder.state, req);
    if (res) return res;
    return original(input as RequestInfo, init);
  });
  return {
    get state() {
      return holder.state;
    },
    reset() {
      holder.state = createFakeState();
    },
  } as { state: FakeState; reset: () => void };
}
