"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveNutritionProviderStatus,
  LiveNutritionTemplateLibrary as Library,
  LiveNutritionVersionContent,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Field, TextInput } from "@/components/ui/Field";
import {
  ClinicalEmpty,
  ClinicalError,
  ClinicalLoading,
  ClinicalNote,
} from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

/**
 * The organization's diet template library.
 *
 * Templates are educational scaffolding. The screen says so where it matters
 * rather than in a footnote, because the difference between a template and a
 * patient's plan is the whole safety argument of this phase.
 */
export function NutritionTemplateLibrary() {
  const { announce } = useFeedback();
  const [library, setLibrary] = useState<Library | null>(null);
  const [provider, setProvider] = useState<LiveNutritionProviderStatus | null>(null);
  const [content, setContent] = useState<LiveNutritionVersionContent | null>(null);
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [lib, status] = await Promise.all([
        api.nutrition.templates(false),
        api.nutrition.providerStatus().catch(() => null),
      ]);
      setLibrary(lib);
      setProvider(status);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      announce(label);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !library) return <ClinicalError message={error} onRetry={() => void load()} />;
  if (!library) return <ClinicalLoading label="Loading template library" />;

  return (
    <div className="space-y-4">
      {error ? <ClinicalError message={error} onRetry={() => void load()} /> : null}

      {/* ------------------------------------------------ provider status */}
      <Card>
        <CardTitle>Food database and copilot</CardTitle>
        {provider ? (
          <>
            <div className="space-y-1 text-sm">
              <div>
                Passio food database:{" "}
                <span className="font-medium">
                  {provider.configured ? "configured" : "not configured"}
                </span>
              </div>
              <div>
                Requests executed:{" "}
                <span className="font-medium">
                  {provider.liveRequestExecuted ? "yes" : "none yet"}
                </span>
              </div>
              <div>
                Nutrition copilot:{" "}
                <span className="font-medium">
                  {provider.copilotEnabled ? "enabled" : "disabled"}
                </span>
              </div>
            </div>
            {provider.problems.length > 0 || provider.copilotProblems.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-xs text-slate-badge">
                {[...provider.problems, ...provider.copilotProblems].map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            {!provider.liveRequestExecuted ? (
              <ClinicalNote>
                Configured and having transacted are different facts. No request has
                been sent to the food database from this deployment, so nothing here
                should be read as proof the integration works. When it is not
                configured, food lookup is simply unavailable — no substitute data is
                shown, because an invented nutrient value is worse than none.
              </ClinicalNote>
            ) : null}
          </>
        ) : (
          <ClinicalEmpty title="Provider status unavailable" message="The boundary status could not be read." />
        )}
      </Card>

      {/* ------------------------------------------------ starter library */}
      <Card>
        <CardTitle>Starter library</CardTitle>
        <p className="text-sm">
          Eight dietary patterns you can install and then edit as your own. Every one
          arrives requiring practitioner review, and none is marked evidence-based —
          this build carries no governed nutrition reference set, so no claim in them
          is backed by a citation.
        </p>
        <div className="mt-3">
          <Btn
            disabled={busy}
            onClick={() =>
              void run("Starter templates installed", () => api.nutrition.installStarters())
            }
          >
            Install starter templates
          </Btn>
        </div>
        <ClinicalNote>
          Installing again is safe. A template whose content has not changed is left
          exactly as it is rather than gaining a version that differs in nothing.
        </ClinicalNote>
      </Card>

      {/* ------------------------------------------------ new template */}
      <Card>
        <CardTitle>Create a template</CardTitle>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Template name">
            <TextInput
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Post-operative soft diet"
            />
          </Field>
          <Btn
            disabled={busy || !newName.trim()}
            onClick={() =>
              void run("Template created", async () => {
                await api.nutrition.upsertTemplate({ name: newName });
                setNewName("");
              })
            }
          >
            Create
          </Btn>
        </div>
      </Card>

      {/* ------------------------------------------------ the library */}
      <Card>
        <CardTitle>Templates</CardTitle>
        {library.templates.length === 0 ? (
          <ClinicalEmpty title="No templates yet" message="Install the starter library, or create a template of your own." />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <TH>Name</TH>
                <TH>Pattern</TH>
                <TH>Origin</TH>
                <TH>Versions</TH>
                <TH>Published</TH>
                <TH>Review</TH>
                <TH>Evidence</TH>
                <TH>Actions</TH>
              </tr>
            </thead>
            <tbody>
              {library.templates.map((t) => {
                const published = t.versions.find((v) => v.status === "published");
                return (
                  <tr key={t.id}>
                    <TD>{t.name}</TD>
                    <TD>{t.pattern.replace(/_/g, " ")}</TD>
                    <TD>{t.isStarter ? "Starter" : "Authored here"}</TD>
                    <TD>{t.versions.length}</TD>
                    <TD>{published ? `v${published.versionNumber}` : "None"}</TD>
                    <TD>
                      {published?.requiresPractitionerReview === false
                        ? "Not required"
                        : "Required"}
                    </TD>
                    <TD>
                      {published?.evidenceGrade
                        ? published.evidenceGrade.replace(/_/g, " ")
                        : "Not graded"}
                    </TD>
                    <TD>
                      {published ? (
                        <Btn
                          variant="ghost"
                          onClick={() =>
                            void (async () => {
                              setOpenVersionId(published.id);
                              setContent(null);
                              try {
                                setContent(
                                  await api.nutrition.versionContent({
                                    templateVersionId: published.id,
                                  }),
                                );
                              } catch (e) {
                                setError(errText(e));
                              }
                            })()
                          }
                        >
                          Open
                        </Btn>
                      ) : (
                        "—"
                      )}
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {/* ------------------------------------------------ open template */}
      {openVersionId ? (
        <Card>
          <CardTitle>Template version</CardTitle>
          {(() => {
            const version = library.templates
              .flatMap((t) => t.versions)
              .find((v) => v.id === openVersionId);
            if (!version) return <ClinicalEmpty title="Version not found" message="That template version is no longer in the library." />;
            return (
              <div className="space-y-3 text-sm">
                {version.purpose ? (
                  <div>
                    <span className="font-medium">Purpose:</span> {version.purpose}
                  </div>
                ) : null}
                {version.intendedUse ? (
                  <div>
                    <span className="font-medium">Intended use:</span> {version.intendedUse}
                  </div>
                ) : null}
                {version.educationVsAdviceNote ? (
                  <ClinicalNote>{version.educationVsAdviceNote}</ClinicalNote>
                ) : null}
                {version.cautionPopulations.length > 0 ? (
                  <div>
                    <span className="font-medium">Caution:</span>
                    <ul className="list-disc pl-5">
                      {version.cautionPopulations.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {version.missingInformationRequired.length > 0 ? (
                  <div>
                    <span className="font-medium">
                      Must be established before this is used for anyone:
                    </span>
                    <ul className="list-disc pl-5">
                      {version.missingInformationRequired.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {version.evidenceSummary ? (
                  <div>
                    <span className="font-medium">Evidence:</span> {version.evidenceSummary}
                  </div>
                ) : null}
                {content ? (
                  <>
                    {content.phases.length > 0 ? (
                      <div>
                        <span className="font-medium">Phases:</span>
                        <ul className="list-disc pl-5">
                          {content.phases.map((p) => (
                            <li key={p.id}>
                              {p.name}
                              {p.relativeDurationDays
                                ? ` — ${p.relativeDurationDays} days`
                                : ""}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <div>
                      <span className="font-medium">Food guidance:</span>
                      <ul className="list-disc pl-5">
                        {content.foodRules.map((r) => (
                          <li key={r.id}>
                            <span className="font-medium">{r.disposition}:</span> {r.label}
                            {r.conditionNote ? ` — ${r.conditionNote}` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                ) : (
                  <ClinicalLoading label="Loading template content" />
                )}
              </div>
            );
          })()}
        </Card>
      ) : null}
    </div>
  );
}
