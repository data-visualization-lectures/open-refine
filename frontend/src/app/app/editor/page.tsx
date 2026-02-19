"use client";

import { FormEvent, useState } from "react";
import { DataTable } from "@/components/DataTable";
import { TransformPanel } from "@/components/TransformPanel";
import { ExportMenu } from "@/components/ExportMenu";

export default function EditorPage() {
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string>("No project created yet.");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem("csvFile") as HTMLInputElement | null;
    const file = fileInput?.files?.[0];

    if (!file) {
      setStatus("Please select a CSV file.");
      return;
    }

    setIsSubmitting(true);
    setStatus("Creating project...");
    try {
      const formData = new FormData();
      formData.append("project-file", file);

      const response = await fetch("/api/refine/upload", {
        method: "POST",
        body: formData
      });

      const payload = (await response.json()) as {
        projectId?: string;
        projectName?: string;
        authMode?: string;
        error?: string;
      };

      if (!response.ok || !payload.projectId) {
        setStatus(payload.error ?? "Failed to create project.");
        return;
      }

      setProjectId(payload.projectId);
      setStatus(
        `Created project ${payload.projectId} (${payload.projectName ?? "unknown name"}) via ${payload.authMode ?? "unknown"} mode.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setStatus(`Request failed: ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: 24, display: "grid", gap: 12 }}>
      <h1 style={{ marginBottom: 8 }}>OpenRefine Editor</h1>
      <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, background: "#fff" }}>
        <h2 style={{ marginTop: 0 }}>Create Project (CSV)</h2>
        <form onSubmit={onCreateProject} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input name="csvFile" type="file" accept=".csv,text/csv" />
          <button type="submit" disabled={isSubmitting} style={{ width: 200 }}>
            {isSubmitting ? "Creating..." : "Create Project"}
          </button>
        </form>
        <p style={{ marginBottom: 0 }}>{status}</p>
      </section>
      <DataTable projectId={projectId} />
      <TransformPanel />
      <ExportMenu />
    </main>
  );
}
