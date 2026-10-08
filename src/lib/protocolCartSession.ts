import {parseProtocolCartResponse, type ProtocolCartRequest, type ProtocolCartResponse} from '@/contracts/protocolCarts';

type Manifest = Extract<ProtocolCartResponse, {action: 'read'}>;
export type ProtocolCartSessionState = {
  manifest: Manifest | null; busy: boolean; error: string | null; notice: string | null;
};
export const emptyProtocolCartState: ProtocolCartSessionState = {
  manifest: null, busy: false, error: null, notice: null,
};
type Post = (request: ProtocolCartRequest, signal: AbortSignal) => Promise<unknown>;

/** One selected published version, never a shared request cache. Disposing the
 * scope aborts transport and prevents a late response from reopening its list.
 * Client checks supplement the server's authority checks, never replace them.
 */
export function createProtocolCartSession(programVersionId: string, post: Post,
  publish: (state: ProtocolCartSessionState) => void) {
  let live = true, busy = false;
  const lifetime = new AbortController();
  return {
    dispose() {live = false; lifetime.abort();},
    async compile() {
      if (!live || busy) return;
      busy = true;
      publish({...emptyProtocolCartState, busy: true});
      try {
        const compileRequest = {action: 'compile' as const, programVersionId};
        const compiled = parseProtocolCartResponse(compileRequest, await post(compileRequest, lifetime.signal));
        if (!live) return;
        if (compiled.action !== 'compile') throw new Error('response_action_mismatch');
        const readRequest = {action: 'read' as const, manifestId: compiled.manifestId};
        const manifest = parseProtocolCartResponse(readRequest, await post(readRequest, lifetime.signal));
        if (!live) return;
        if (manifest.action !== 'read' || manifest.programVersionId !== programVersionId
          || manifest.programVersion !== compiled.programVersion || manifest.contentSha256 !== compiled.contentSha256
          || manifest.includedCount !== compiled.includedCount || manifest.excludedCount !== compiled.excludedCount) {
          throw new Error('response_version_mismatch');
        }
        publish({manifest, busy: false, error: null,
          notice: compiled.replayed ? 'This list was already built for this version. Nothing was rebuilt.' : null});
      } catch {
        if (live) publish({...emptyProtocolCartState,
          error: 'That list could not be verified. Refresh and try again. No ordering request was sent.'});
      } finally {busy = false;}
    },
  };
}
