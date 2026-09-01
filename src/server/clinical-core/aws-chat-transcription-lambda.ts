import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DeleteTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  TranscribeClient,
} from "@aws-sdk/client-transcribe";

type Event = {
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
};
type Response = { statusCode: number; headers: Record<string, string>; body: string };

const MAX_AUDIO_BASE64 = 5_500_000;
const CONSENT_VERSION = "patient-chat-consent/1";
const ALLOWED_MIME = new Map([
  ["audio/m4a", "mp4"], ["audio/mp4", "mp4"], ["audio/wav", "wav"],
] as const);
const s3 = new S3Client({});
const transcribe = new TranscribeClient({});

function response(statusCode: number, body: Record<string, unknown>): Response {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

function configuration(): { bucket: string } {
  const bucket = process.env.TRANSCRIPTION_BUCKET ?? "";
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || process.env.DATA_CLASSIFICATION !== "synthetic_only"
    || process.env.PHI_ALLOWED !== "false") throw new Error("transcription_configuration_refused");
  return { bucket };
}

function parse(event: Event): { bytes: Uint8Array; format: "mp4" | "wav" } {
  const encoded = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, "base64").toString("utf8") : event.body ?? "";
  if (Buffer.byteLength(encoded, "utf8") > MAX_AUDIO_BASE64 + 1_024) throw new Error("request_invalid");
  const body = JSON.parse(encoded) as Record<string, unknown>;
  if (body.consentVersion !== CONSENT_VERSION || body.purpose !== "patient_chat_voice_input"
    || typeof body.audioBase64 !== "string" || body.audioBase64.length < 4
    || body.audioBase64.length > MAX_AUDIO_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(body.audioBase64)
    || typeof body.mimeType !== "string" || !ALLOWED_MIME.has(body.mimeType as never)) {
    throw new Error("request_invalid");
  }
  const bytes = Buffer.from(body.audioBase64, "base64");
  if (bytes.byteLength < 32 || bytes.byteLength > 4_125_000) throw new Error("request_invalid");
  return { bytes, format: ALLOWED_MIME.get(body.mimeType as never)! };
}

async function streamText(body: unknown): Promise<string> {
  if (!body || typeof body !== "object" || !("transformToString" in body)) throw new Error("transcription_failed");
  return (body as { transformToString(): Promise<string> }).transformToString();
}

export async function handler(event: Event): Promise<Response> {
  let inputKey = ""; let outputKey = ""; let jobName = ""; let bucket = "";
  try {
    const subject = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (typeof subject !== "string" || subject.length < 8) return response(401, { error: "identity_refused" });
    ({ bucket } = configuration());
    const audio = parse(event);
    const id = randomUUID();
    jobName = `alp-synthetic-chat-${id}`;
    inputKey = `temporary-input/${id}.${audio.format}`;
    outputKey = `temporary-output/${id}.json`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: inputKey, Body: audio.bytes,
      ContentType: audio.format === "wav" ? "audio/wav" : "audio/mp4", ServerSideEncryption: "aws:kms" }));
    await transcribe.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName, LanguageCode: "en-US", MediaFormat: audio.format,
      Media: { MediaFileUri: `s3://${bucket}/${inputKey}` }, OutputBucketName: bucket, OutputKey: outputKey,
      Settings: { ShowSpeakerLabels: false },
    }));
    const deadline = Date.now() + 24_000;
    while (Date.now() < deadline) {
      const job = (await transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }))).TranscriptionJob;
      if (job?.TranscriptionJobStatus === "FAILED") throw new Error("transcription_failed");
      if (job?.TranscriptionJobStatus === "COMPLETED") {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: outputKey }));
        const document = JSON.parse(await streamText(object.Body)) as { results?: { transcripts?: Array<{ transcript?: string }> } };
        const transcript = document.results?.transcripts?.[0]?.transcript?.trim().slice(0, 4_000);
        if (!transcript) throw new Error("transcription_failed");
        return response(200, { transcript });
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    throw new Error("transcription_timeout");
  } catch {
    return response(503, { error: "chat_transcription_unavailable" });
  } finally {
    await Promise.allSettled([
      inputKey && bucket ? s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: inputKey })) : Promise.resolve(),
      outputKey && bucket ? s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: outputKey })) : Promise.resolve(),
      jobName ? transcribe.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName })) : Promise.resolve(),
    ]);
  }
}
