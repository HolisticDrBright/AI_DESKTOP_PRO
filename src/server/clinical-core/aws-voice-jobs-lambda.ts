import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteTranscriptionJobCommand, GetTranscriptionJobCommand, StartTranscriptionJobCommand, TranscribeClient } from "@aws-sdk/client-transcribe";
import { VoiceJobs, VOICE_CLEANUP_WATCH, type VoiceJob, type VoiceProvider, type VoiceRepository } from "./voice-jobs";
import type {VoiceAuthorizationPolicy} from './voice-authorization';
import {erasePersonalVoiceObjects} from './voice-object-cleanup';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const transcribe = new TranscribeClient({});
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error("voice_configuration_refused"); return value; };
const conditional = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";
const absent = (error: unknown) => error instanceof Error && error.name === "BadRequestException" && /couldn't be found|not found|does not exist|doesn't exist/i.test(error.message);

export function awsVoiceJobs(): VoiceJobs {
  if (required("DATA_CLASSIFICATION") !== "synthetic_only" || required("PHI_ALLOWED") !== "false") throw new Error("voice_configuration_refused");
  const table = required("VOICE_JOB_TABLE"), bucket = required("TRANSCRIPTION_BUCKET"), kms = required("VOICE_KMS_KEY_ARN");
  return createAwsVoiceService({table,bucket,kms,mode:'synthetic'});
}
export function createAwsVoiceService(options:{table:string;bucket:string;kms:string}&(
  {mode:'synthetic';policy?:never}|{mode:'production';policy:VoiceAuthorizationPolicy}
)):VoiceJobs{
  const {table,bucket,kms}=options;
  if(!table||!bucket||!kms||(options.mode==='production'&&!options.policy))throw new Error('voice_configuration_refused');
  const inputKey = (job: VoiceJob) => `${options.mode==='production'?'personal-voice/input':'temporary-input'}/${job.id}.${job.format}`;
  const outputKey = (job: VoiceJob) => `${options.mode==='production'?'personal-voice/output':'temporary-output'}/${job.id}.json`;
  const jobName = (job: VoiceJob) => `alp-${options.mode==='production'?'personal':'synthetic'}-voice-${job.id}`;
  const repo: VoiceRepository = {
    async get(id) { return (await db.send(new GetCommand({ TableName: table, Key: { id }, ConsistentRead: true }))).Item as VoiceJob | undefined; },
    async insert(job) {
      try { await db.send(new PutCommand({ TableName: table, Item: job, ConditionExpression: "attribute_not_exists(id)" })); return true; }
      catch (error) { if (conditional(error)) return false; throw error; }
    },
    async acquire(id, token, now) {
      try {
        return (await db.send(new UpdateCommand({ TableName: table, Key: { id },
          ConditionExpression: "attribute_exists(id) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)",
          UpdateExpression: "SET leaseToken = :token, leaseUntil = :until",
          ExpressionAttributeValues: { ":now": now, ":until": now + 90, ":token": token },
          ReturnValues: "ALL_NEW" }))).Attributes as VoiceJob;
      } catch (error) { if (conditional(error)) return undefined; throw error; }
    },
    async release(id, token, changes) {
      const clean = changes.state === "cleaned";
      if (clean && (changes.cleanupWatchVersion !== VOICE_CLEANUP_WATCH || !Number.isSafeInteger(changes.lastCleanupAt)
        || changes.lastCleanupAt! < 0 || !Number.isSafeInteger(changes.nextWork) || changes.nextWork! <= changes.lastCleanupAt!)) throw new Error('voice_cleanup_watch_invalid');
      await db.send(new UpdateCommand({ TableName: table, Key: { id }, ConditionExpression: "leaseToken = :token",
        UpdateExpression: `SET nextWork = :due${changes.state ? ", #state = :state" : ""}${clean ? ", pending = :work, cleanupWatchVersion = :watch, lastCleanupAt = :verified" : ""} REMOVE leaseToken, leaseUntil${clean ? ", expiresAt" : ""}`,
        ...(changes.state ? { ExpressionAttributeNames: { "#state": "state" } } : {}),
        ExpressionAttributeValues: { ":token": token, ":due": changes.nextWork, ...(changes.state ? { ":state": changes.state } : {}), ...(clean ? { ":work": "work", ":watch": VOICE_CLEANUP_WATCH, ":verified": changes.lastCleanupAt } : {}) } }));
    },
    async cancel(id, owner) {
      try { await db.send(new UpdateCommand({ TableName: table, Key: { id }, ConditionExpression: "#owner = :owner AND #state <> :cleaned",
        UpdateExpression: "SET cancelled = :yes, nextWork = :now", ExpressionAttributeNames: { "#owner": "owner", "#state": "state" },
        ExpressionAttributeValues: { ":owner": owner, ":cleaned": "cleaned", ":yes": true, ":now": Math.floor(Date.now() / 1000) } })); }
      catch (error) { if (!conditional(error)) throw error; }
    },
    async due(now) {
      const result = await db.send(new QueryCommand({ TableName: table, IndexName: "PendingWork", KeyConditionExpression: "pending = :work AND nextWork <= :now",
        ExpressionAttributeValues: { ":work": "work", ":now": now }, Limit: 25, ProjectionExpression: "id" }));
      return (result.Items ?? []).map(row => String(row.id));
    },
  };
  const provider: VoiceProvider = {
    async upload(job, bytes) { await s3.send(new PutObjectCommand({ Bucket: bucket, Key: inputKey(job), Body: bytes, ContentType: job.format === "wav" ? "audio/wav" : "audio/mp4", ServerSideEncryption: "aws:kms", SSEKMSKeyId: kms })); },
    async start(job) {
      try { await transcribe.send(new StartTranscriptionJobCommand({ TranscriptionJobName: jobName(job), LanguageCode: "en-US", MediaFormat: job.format,
        Media: { MediaFileUri: `s3://${bucket}/${inputKey(job)}` }, OutputBucketName: bucket, OutputKey: outputKey(job), OutputEncryptionKMSKeyId: kms,
        Settings: { ShowSpeakerLabels: false } })); }
      catch (error) { if (!(error instanceof Error && error.name === "ConflictException")) throw error; }
    },
    async status(job) {
      try {
        const state = (await transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName(job) }))).TranscriptionJob?.TranscriptionJobStatus;
        if (state === "COMPLETED") return "ready";
        if (state === "FAILED") return "failed";
        if (state === "QUEUED" || state === "IN_PROGRESS") return "processing";
        throw new Error("voice_provider_response_invalid");
      } catch (error) { if (absent(error)) return "missing"; throw error; }
    },
    async transcript(job) {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: outputKey(job) }));
      if (!object.Body || (object.ContentLength ?? Infinity) > 1_000_000) throw new Error("voice_transcript_refused");
      const raw = await object.Body.transformToString();
      if (Buffer.byteLength(raw) > 1_000_000) throw new Error("voice_transcript_refused");
      const value = JSON.parse(raw)?.results?.transcripts?.[0]?.transcript;
      if (typeof value !== "string" || value.length > 4000) throw new Error("voice_transcript_refused");
      return value.trim();
    },
    async remove(job) {
      // Only called after a terminal/absent provider status; deletion errors remain retryable.
      try { await transcribe.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName(job) })); }
      catch (error) { if (!absent(error)) throw error; }
      if(options.mode==='production'){await erasePersonalVoiceObjects(s3,bucket,job);return;}
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: inputKey(job) }));
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: outputKey(job) }));
    },
  };
  return new VoiceJobs(repo, provider,undefined,options.policy);
}

type Event = { source?: string; rawPath?: string; body?: string; isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string }; authorizer?: { jwt?: { claims?: Record<string, unknown> } } } };
const reply = (statusCode: number, body: unknown) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
export async function handler(event: Event) {
  try {
    const service = awsVoiceJobs();
    if (event.source === "aws.events" && !event.requestContext) { await service.sweep(); return reply(200, { swept: true }); }
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (typeof claims?.sub !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(claims.sub)
      || claims["custom:synthetic_attested"] !== "true" || claims["custom:production_bound"] === "true") return reply(403, { error: "identity_refused" });
    const path = event.rawPath ?? "", method = event.requestContext?.http?.method;
    if (path === "/clinical-core/consumer/chat-transcription/jobs" && method === "POST") {
      if (!event.body || event.body.length > 7_400_000) return reply(400, { error: "voice_request_refused" });
      const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "voice_request_refused" });
      return reply(202, await service.start(claims.sub, body));
    }
    const id = path.match(/^\/clinical-core\/consumer\/chat-transcription\/jobs\/([a-f0-9]{64})$/)?.[1];
    if (!id) return reply(404, { error: "voice_job_not_found" });
    if (method === "GET") return reply(200, await service.status(claims.sub, id));
    if (method === "DELETE") return reply(202, await service.cancel(claims.sub, id));
    return reply(404, { error: "voice_job_not_found" });
  } catch (error) {
    const code = error && typeof error === "object" && "status" in error ? Number(error.status) : 503;
    return reply([400, 404].includes(code) ? code : 503, { error: code === 404 ? "voice_job_not_found" : "chat_transcription_unavailable" });
  }
}
