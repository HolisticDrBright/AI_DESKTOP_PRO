if(typeof window!=='undefined')throw Error('Fullscript credential target is server-only.');
import {z} from 'zod';
const arn=z.string().regex(/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/);
const version=z.string().regex(/^[A-Za-z0-9-]{32,64}$/);
export const fullscriptCredentialRedirectSchema=z.string().url().refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password
 &&!u.search&&!u.hash&&u.pathname==='/api/live/fullscript/oauth/callback';}catch{return false;}});
/** Pure metadata contract; importing it never constructs a secret client. */
export const fullscriptCredentialTargetSchema=z.object({providerSecretArn:arn,providerSecretVersion:version,
 tokenTable:z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),redirectUri:fullscriptCredentialRedirectSchema}).strict();
