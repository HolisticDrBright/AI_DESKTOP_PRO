if (typeof window !== 'undefined') throw new Error('staff media host is server-only');
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import type { StaffMediaReply } from './learner-media';

/**
 * The WORKFORCE host for the learner media read: a clinician viewing an admitted slot of a published
 * version of their own clinic's program, as a learner would see it. It is a separate host from the
 * consumer one and is installed only by a reviewed bootstrap that has a verified workforce identity
 * (MFA session, current membership). The reviewed commerce runtime has none, so nothing in this source
 * installs it: the route answers `staff_media_host_unavailable`. An author's private preview is a
 * different operation with its own authority and is never served here; learner progress is not part
 * of this read (its visibility is an owner decision that is still held).
 */
export type StaffMediaHost = {
  readonly kind: 'reviewed';
  identify(request: Request): Promise<ClinicalRequestContext | null>;
  read(context: ClinicalRequestContext, body: unknown, live: { assertLive?: () => void }): Promise<StaffMediaReply>;
};
const KEY = Symbol.for('alp.programs.staff-media-host');
type State = { installed: StaffMediaHost | null };
const state = (): State => ((globalThis as unknown as Record<symbol, State | undefined>)[KEY] ??= { installed: null });

/** For a reviewed bootstrap with a verified workforce identity only. */
export function installStaffMediaHost(host: StaffMediaHost): void {
  if (host.kind !== 'reviewed') throw new Error('staff_media_host_must_be_reviewed');
  if (state().installed) throw new Error('staff_media_host_already_installed');
  state().installed = host;
}
export function selectStaffMediaHost(): StaffMediaHost | null { return state().installed; }
export function __resetStaffMediaHost(): void { state().installed = null; }
