import { funnelDefinition, type FunnelDefinition } from './schema';
import { diabetesProgram } from './definitions/diabetes-program';
import { longevityProgram } from './definitions/longevity-program';
import { weightLossPeptideProgram } from './definitions/weight-loss-peptide-program';

/**
 * Every funnel in the repository, validated at import so a definition that breaks the text rules
 * fails the build rather than reaching a visitor. Order is Brandon's: Longevity, weight loss,
 * diabetes. Imports nothing clinical.
 */
export const FUNNELS: readonly FunnelDefinition[] = Object.freeze([longevityProgram, weightLossPeptideProgram, diabetesProgram].map(definition => funnelDefinition.parse(definition)));
if (new Set(FUNNELS.map(f => f.slug)).size !== FUNNELS.length) throw new Error('funnel slugs must be unique');
const handoffSlugs = FUNNELS.flatMap(f => [f.consultSlug, ...Object.values(f.channelConsultSlugs ?? {})]);
if (new Set(handoffSlugs).size !== handoffSlugs.length) throw new Error('each consult slug belongs to one funnel and one channel');

/** The public route's resolver: a draft and an unknown slug are the same absence. */
export function publishedFunnel(slug: string): FunnelDefinition | null {
  return FUNNELS.find(funnel => funnel.slug === slug && funnel.status === 'published') ?? null;
}
export function allFunnels(): readonly FunnelDefinition[] { return FUNNELS; }
export { funnelDefinition, funnelTextIssue, type FunnelDefinition, type FunnelSection } from './schema';
export { CHANNEL_LABEL, FUNNEL_CHANNELS, consultSlugFor, funnelChannelFrom, funnelConsultSlugs, funnelSourceOf, type FunnelChannel } from './channels';
