import { z } from 'zod';

/** A recorded native publication carried by one lesson. This is data, not a
 * signed URL or read grant: learner authority must resolve it on the server. */
export const PROGRAM_LESSON_NATIVE_MEDIA = 'program-item-native-media/1' as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const source = z.enum(['supplied_by_author', 'supplied_vendor_file']);
const contentTypes = {
  video: { 'video/mp4': 'mp4', 'video/webm': 'webm' },
  image: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' },
} as const;
export const programLessonMediaReference = z.object({
  contractVersion: z.literal('program-media-reference/1'),
  artifactId: uuid, version: z.number().int().safe().min(1), sha256: digest,
  kind: z.enum(['video', 'image']),
  contentType: z.enum(['video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/webp']),
  bytes: z.number().int().safe().min(1).max(268_435_456),
  origin: z.object({ clinic: uuid, programId: uuid }).strict(),
  url: z.string().max(2048).url(), publishedAt: z.string().datetime({ offset: true }),
  caption: z.object({ source, sha256: digest }).strict().nullable(),
  transcript: z.object({ source, sha256: digest, format: z.enum(['plain', 'vtt']) }).strict().nullable(),
}).strict().superRefine((r, c) => {
  const extension = (contentTypes[r.kind] as Record<string, string>)[r.contentType];
  let exact = false;
  try {
    const u = new URL(r.url), path = '/program-media/' + r.origin.clinic + '/' + r.origin.programId + '/' + r.artifactId + '/' + r.sha256 + '.' + extension;
    exact = u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash
      && u.hostname.includes('.') && !u.hostname.includes(':') && !/^(?:\d+\.){3}\d+$/.test(u.hostname)
      && !/\.(?:localhost|local|internal)$/.test(u.hostname) && r.url === u.origin + path;
  } catch { /* malformed addresses have no admitted identity */ }
  if (!extension || !exact || (r.kind === 'image' && (r.bytes > 16_777_216 || r.transcript !== null)))
    c.addIssue({ code: 'custom', message: 'program_native_media_identity_invalid' });
});
export type ProgramLessonMediaReference = z.infer<typeof programLessonMediaReference>;
export const programLessonNativeMedia = z.array(programLessonMediaReference).max(5).superRefine((rows, c) => {
  if (new Set(rows.map(r => r.origin.clinic + '/' + r.origin.programId + '/' + r.artifactId + '/' + r.version)).size !== rows.length)
    c.addIssue({ code: 'custom', message: 'program_native_media_identity_duplicate' });
});
