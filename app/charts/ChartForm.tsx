"use client";

// Shared chart create/edit form. Used by ChartsClient (creating new library
// charts) and ChartViewerClient (editing an existing chart from its own page).
// The owning component holds the FormState and the file-input ref so each can
// wire its own create-vs-edit save flow.

export type FormState = {
  mode: "new" | "edit";
  id?: string;
  title: string;
  artist: string;
  content: string;
};

export const EMPTY_FORM: FormState = {
  mode: "new",
  title: "",
  artist: "",
  content: "",
};

export function ChartForm({
  form,
  setForm,
  busy,
  error,
  onSave,
  onCancel,
  onPickFile,
  fileRef,
  onFile,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState | null>>;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
  onPickFile: () => void;
  fileRef: React.RefObject<HTMLInputElement>;
  onFile: (file: File | undefined) => void;
}) {
  return (
    <section className="mb-6 border border-cat-practice/40 bg-ink-raised/30 p-4">
      <h2 className="mb-3 font-display text-lg text-cream">
        {form.mode === "edit" ? "Edit chart" : "New chart"}
      </h2>
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="flex-1">
            <span className="mb-1 block font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
              Title
            </span>
            <input
              value={form.title}
              onChange={(e) =>
                setForm((f) => (f ? { ...f, title: e.target.value } : f))
              }
              placeholder="Song title"
              className="w-full border border-rule/60 bg-ink px-3 py-2 text-sm text-cream outline-none focus:border-cat-practice/60"
            />
          </label>
          <label className="flex-1">
            <span className="mb-1 block font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
              Artist (optional)
            </span>
            <input
              value={form.artist}
              onChange={(e) =>
                setForm((f) => (f ? { ...f, artist: e.target.value } : f))
              }
              placeholder="Artist"
              className="w-full border border-rule/60 bg-ink px-3 py-2 text-sm text-cream outline-none focus:border-cat-practice/60"
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 flex items-center justify-between font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
            <span>Chart text</span>
            <button
              type="button"
              onClick={onPickFile}
              className="text-cat-practice hover:underline"
            >
              Upload .txt
            </button>
          </span>
          <textarea
            value={form.content}
            onChange={(e) =>
              setForm((f) => (f ? { ...f, content: e.target.value } : f))
            }
            placeholder={"[Verse 1]\nG            C\nPaste the chart here..."}
            rows={12}
            spellCheck={false}
            className="w-full resize-y whitespace-pre border border-rule/60 bg-ink px-3 py-2 font-mono text-[0.8rem] leading-relaxed text-cream outline-none focus:border-cat-practice/60"
          />
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.chordpro,.cho,.crd,.pro,text/plain"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        {error && <p className="text-sm text-cat-music">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            onClick={onSave}
            disabled={busy}
            className="border border-cat-practice/60 bg-cat-practice/10 px-4 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream transition-colors hover:bg-cat-practice/20 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="border border-rule/60 px-4 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:text-cream disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}
