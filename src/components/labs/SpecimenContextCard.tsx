"use client";
import {useEffect,useRef,useState} from "react";
import {labSpecimenRecordSchema,type LabSpecimenRecord} from "@/contracts/labSpecimenTransfer";

/** Read-only, selection-keyed in the workspace. Does not approve context,
 * change lab ranges or infer missing collection facts. */
export function SpecimenContextCard({patientId,observationId,eventId}:{patientId:string;observationId:string;eventId:string}){
  const [record,setRecord]=useState<LabSpecimenRecord|null>(null);
  const [state,setState]=useState<"idle"|"loading"|"ready"|"error">("idle");
  const [error,setError]=useState("");
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>{active.current?.abort();},[]);
  async function load(){
    active.current?.abort();const controller=new AbortController();active.current=controller;
    setRecord(null);setError("");setState("loading");
    try{
      const response=await fetch("/api/live/labs/specimen-context",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({patientId,observationId,eventId}),cache:"no-store",signal:controller.signal});
      if(!response.ok)throw new Error(response.status===401?"Sign in again to read shared context.":response.status===403
        ?"Shared context is not enabled or you do not have access.":"Shared context could not be loaded. Try again.");
      const body=await response.json();
      const parsed=labSpecimenRecordSchema.nullable().safeParse(body?.data);
      if(!parsed.success||(parsed.data&&parsed.data.labEventId!==eventId))throw new Error("The service did not return matching collection context.");
      if(!controller.signal.aborted){setRecord(parsed.data);setState("ready");}
    }catch(cause){
      if(!controller.signal.aborted){setError(cause instanceof Error&&[
        "Sign in again to read shared context.","Shared context is not enabled or you do not have access.",
        "Shared context could not be loaded. Try again.","The service did not return matching collection context.",
      ].includes(cause.message)?cause.message:"Shared context could not be loaded. Try again.");setState("error");}
    }
  }
  const c=record?.context;
  return <section className="mt-3 border-t border-hairline pt-3 text-xs" aria-label="Patient-shared collection context">
    <h3 className="font-semibold">Patient-shared collection context</h3>
    <p>Supplemental, patient-reported and unverified. Receipt does not approve a diagnosis, assay or population reference range.</p>
    <button type="button" disabled={state==="loading"} onClick={()=>void load()} className="my-2 rounded border border-line px-3 py-2 disabled:opacity-50">
      {state==="loading"?"Loading shared context…":state==="idle"?"Load shared collection context":"Refresh shared collection context"}
    </button>
    {state==="error"?<p role="alert">{error}</p>:null}
    {state==="ready"&&!record?<p>No shared collection context is available for this exact result.</p>:null}
    {c&&record?<dl className="grid grid-cols-2 gap-2">
      <dt>Collected</dt><dd>{c.observedOn}</dd>
      <dt>Completed age at collection</dt><dd>{c.ageAtDraw.value} {c.ageAtDraw.unit}</dd>
      <dt>Recorded sex</dt><dd>{c.sex??"Not shared"}</dd>
      <dt>Assay identifier</dt><dd>{c.assayId??"Not shared"} (not verified)</dd>
      <dt>Pregnancy status</dt><dd>{c.pregnancyStatus??"Not shared"}</dd>
      <dt>Trimester</dt><dd>{c.pregnancyTrimester??"Not shared"}</dd>
      <dt>Cycle phase</dt><dd>{c.cyclePhase??"Not shared"}</dd>
      <dt>Reproductive stage</dt><dd>{c.reproductiveStage?.replaceAll("_"," ")??"Not shared"}</dd>
      <dt>Contraception</dt><dd>{c.contraception?.replaceAll("_"," ")??"Not shared"}</dd>
      <dt>Patient recorded</dt><dd>{c.recordedAt}</dd>
      <dt>Received / revision</dt><dd>{record.receivedAt} / {record.revision}</dd>
    </dl>:null}
  </section>;
}
