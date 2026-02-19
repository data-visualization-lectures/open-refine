type DataTableProps = {
  projectId?: string;
};

export function DataTable({ projectId }: DataTableProps) {
  return (
    <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, background: "#fff" }}>
      <h2 style={{ marginTop: 0 }}>Data Table</h2>
      <p>Project ID: {projectId ?? "not loaded"}</p>
    </section>
  );
}
