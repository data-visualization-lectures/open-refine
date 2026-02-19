export default function EditorPage() {
  return (
    <main style={{ height: "100vh", width: "100%", overflow: "hidden", background: "#fff" }}>
      <iframe
        src="/openrefine/"
        title="OpenRefine UI"
        style={{ border: 0, width: "100%", height: "100%" }}
        referrerPolicy="no-referrer"
      />
    </main>
  );
}
