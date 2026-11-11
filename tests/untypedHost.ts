/**
 * Returns the value typed as the parameter it goes to, as a host outside TypeScript would pass it. A test can then
 * reach the runtime checks that guard against values the types rule out.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller's parameter type infers `T`.
export function fromUntypedHost<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a host outside TypeScript can pass anything.
  return value as T;
}
